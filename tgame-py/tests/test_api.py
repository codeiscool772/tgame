import io
import json
import os
import subprocess
import sys

import pytest

import tgame
from tgame.cli import main

CAVE = """@format 3
@title The Cave
@start entrance
@set score = 0

:: entrance
The cave mouth yawns open.

if not has lamp:
A lamp lies in the dirt.
* Take the lamp | grab lamp -> entrance [get lamp, score += 5]
end

* Go north -> hall
* Walk back -> village

:: hall
You made it. Score: {score}. Carrying: {inventory}.
-> END

:: village
You go home.
-> END
"""

NAME = """@format 3
@title Name
:: start
? Your name? [name:text] -> next
:: next
Hello, {name}.
-> END
"""


def play_script(src, answers, **kw):
    out = io.StringIO()
    it = iter(answers)

    def fake_input(prompt=""):
        try:
            return next(it)
        except StopIteration:
            raise EOFError

    kw.setdefault("effects", False)
    status = tgame.play(src, input_fn=fake_input, out=out, **kw)
    return status, out.getvalue()


# ------------------------------------------------------------------ loading / inspecting
def test_loads_and_inspect():
    g = tgame.loads(CAVE)
    assert g.title == "The Cave"
    assert g.start == "entrance"
    assert [p.name for p in g.passages] == ["entrance", "hall", "village"]
    assert g.passage("entrance").links == ["entrance", "hall", "village"]
    assert g.passage("hall").is_ending and g.passage("village").is_ending
    assert not g.passage("entrance").is_ending
    assert g.ok and g.lint() == []
    s = g.stats()
    assert s["passages"] == 3 and s["unreachable"] == [] and s["endings"] == ["hall", "village"]
    assert "hall" in g and "nowhere" not in g and len(g) == 3


def test_to_dict_is_json():
    d = json.loads(tgame.loads(CAVE).to_json())
    assert d["meta"]["title"] == "The Cave" and len(d["passages"]) == 3
    assert d["passages"][0]["text"].startswith(":: entrance")


def test_load_from_file_and_save_roundtrip(tmp_path):
    p = tmp_path / "cave.tgame"
    p.write_bytes(CAVE.replace("\n", "\r\n").encode("utf-8"))
    g = tgame.load(str(p))
    assert g.title == "The Cave" and g.ok
    g.set_meta("title", "Renamed")
    g.save()
    raw = p.read_bytes()
    assert b"\r\n" in raw and b"@title Renamed" in raw          # CRLF preserved
    assert tgame.load(p).title == "Renamed"


def test_top_level_helpers_accept_path_game_or_text(tmp_path):
    p = tmp_path / "c.tgame"
    p.write_text(CAVE, encoding="utf-8")
    assert tgame.check(str(p)) == tgame.check(CAVE) == tgame.check(tgame.loads(CAVE)) == []
    assert tgame.run(p, [0, 0], seed=1).ended


# ------------------------------------------------------------------ running
def test_headless_run():
    r = tgame.run(CAVE, ["grab lamp", "go north"], seed=7)
    assert r.ended and r.error is None
    assert "Score: 5" in r.text and "lamp" in r.text
    assert r.vars["score"] == 5 and r.inventory == ["lamp"]
    assert r.history == [{"t": "c", "i": 0}, {"t": "c", "i": 0}]     # the lamp choice disappears once taken
    w = tgame.run(CAVE, [])
    assert w.waiting == "choice" and w.choices[0].startswith("Take")
    bad = tgame.run(CAVE, ["dance"])
    assert bad.error and "no matching" in bad.error


def test_run_refuses_a_broken_game():
    r = tgame.run("@format 3\n:: a\n-> nowhere\n")
    assert r.error and "missing passage" in r.error


def test_typed_input():
    r = tgame.run(NAME, ["Ada"])
    assert r.ended and "Hello, Ada." in r.text
    assert tgame.run(NAME, []).waiting == "input"


def test_seed_is_deterministic():
    src = "@format 3\n:: a\n[r = random(1, 1000000)]\n{r}\n-> END\n"
    assert tgame.run(src, seed=5).lines == tgame.run(src, seed=5).lines
    assert tgame.run(src, seed=5).lines != tgame.run(src, seed=6).lines


# ------------------------------------------------------------------ editing
def test_rename_updates_every_reference():
    src = ("@format 3\n@start a\n:: a\n{visited b | seen | unseen}\n* Go -> b\n? Q? [x] -> b\n-> b\n>> b\n"
           "if visited B:\nyes\nend\n:: b\nhi\n")
    g = tgame.loads(src)
    n = g.rename_passage("b", "Beta")
    assert n >= 6
    assert ":: Beta" in g.source
    assert g.ok, g.lint()
    assert "-> b" not in g.source.replace(":: b", "") and ">> b" not in g.source
    assert "-> Beta" in g.source and ">> Beta" in g.source and "visited Beta" in g.source
    with pytest.raises(ValueError):
        g.rename_passage("a", "Beta")
    with pytest.raises(KeyError):
        g.rename_passage("nope", "x")
    with pytest.raises(ValueError):
        g.rename_passage("a", "bad name")


def test_rename_keeps_game_behaviour():
    g = tgame.loads(CAVE)
    before = g.run(["grab lamp", "north"], seed=3)
    g.rename_passage("hall", "great-hall")
    after = g.run(["grab lamp", "north"], seed=3)
    assert before.lines == after.lines and before.vars == after.vars and after.ended


def test_set_meta_add_remove_passage():
    g = tgame.loads(CAVE)
    g.set_meta("author", "Me")
    assert g.author == "Me"
    g.add_passage("cellar", "Damp.\n-> END", tags=["dark"])
    assert g.passage("cellar").tags == ["dark"] and "cellar" in g
    dangling = g.remove_passage("village")
    assert dangling == ["entrance"] and "village" not in g
    assert not g.ok                                   # entrance still links to it


# ------------------------------------------------------------------ terminal player
def test_terminal_play_through():
    status, out = play_script(CAVE, ["1", "1"], seed=1)       # take the lamp, then go north
    assert status == 0 and "A lamp lies" in out


def test_terminal_full_game_and_commands():
    status, out = play_script(CAVE, ["help", "take lamp", "go north"], seed=1)
    assert status == 0
    assert "Commands available here" in out and "Score: 5" in out and "The End" in out


def test_terminal_undo_save_load(tmp_path):
    sd = str(tmp_path)
    status, out = play_script(CAVE, ["grab lamp", "save", "undo", "undo", "load", "north"], seed=2, save_dir=sd)
    assert "Game saved." in out and "Nothing to undo." in out
    assert "Score: 5" in out.split("Game saved.")[-1]         # load brought the lamp back
    saved = json.loads(open(os.path.join(sd, "The_Cave.json"), encoding="utf-8").read())
    assert saved["v"] == 1 and saved["history"] == [{"t": "c", "i": 0}] and saved["seed"] == 2


def test_terminal_refuses_broken_game():
    status, out = play_script("@format 3\n:: a\n-> nowhere\n", [])
    assert status == 1 and "missing passage" in out


def test_terminal_ambiguous_and_unknown():
    src = "@format 3\n@parser\n:: a\n* Take the lamp -> END\n* Take the key -> END\n"
    status, out = play_script(src, ["take", "dance", "lamp"])
    assert "Which do you mean?" in out and "I don't understand" in out and "The End" in out


# ------------------------------------------------------------------ html export
def test_html_is_self_contained():
    html = tgame.loads(CAVE).to_html()
    assert html.startswith("<!doctype html>") and "TgamePlayer" in html and "The Cave" in html
    assert html.count("<script>") == 1 and html.count("</script>") == 1
    tricky = tgame.loads("@format 3\n@title A </script> B\n:: a\nx </script> y\n-> END\n").to_html()
    assert tricky.count("</script>") == 1


# ------------------------------------------------------------------ command line
def _write(tmp_path, text=CAVE, name="cave.tgame"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_cli_check_info_json(tmp_path, capsys):
    f = _write(tmp_path)
    assert main(["check", f]) == 0 and "ok" in capsys.readouterr().out
    assert main(["info", f]) == 0 and "3 passages" in capsys.readouterr().out
    assert main(["info", "--json", f]) == 0 and json.loads(capsys.readouterr().out)["start"] == "entrance"
    bad = _write(tmp_path, "@format 3\n:: a\n-> nowhere\n", "bad.tgame")
    assert main(["check", bad]) == 1 and "missing passage" in capsys.readouterr().out


def test_cli_run_html_rename(tmp_path, capsys):
    f = _write(tmp_path)
    assert main(["run", f, "-i", "grab lamp", "-i", "north", "--seed", "1"]) == 0
    assert "Score: 5" in capsys.readouterr().out
    assert main(["html", f]) == 0 and (tmp_path / "cave.html").exists()
    assert main(["rename", f, "hall", "grand"]) == 0 and ":: grand" in open(f, encoding="utf-8").read()
    assert main(["check", f]) == 0
    assert main(["rename", f, "nope", "x"]) == 1


def test_cli_default_is_play(tmp_path, monkeypatch, capsys):
    f = _write(tmp_path)
    monkeypatch.setattr("builtins.input", lambda prompt="": (_ for _ in ()).throw(EOFError()))
    assert main([f, "--no-effects"]) == 0
    assert "The cave mouth yawns open." in capsys.readouterr().out


def test_module_entry_point(tmp_path):
    f = _write(tmp_path)
    r = subprocess.run([sys.executable, "-m", "tgame", "check", f], capture_output=True, text=True)
    assert r.returncode == 0 and "ok" in r.stdout


def test_plain_lines_strip_markup():
    r = tgame.run('@format 3\n:: a\nHello *there* **you**.\n-> END\n')
    assert r.lines == ['Hello *there* **you**.'] and r.plain == ['Hello there you.']



def test_shipped_runtime_matches_the_reference_engine():
    # in the monorepo, tgame_build/runtime.js is the source of truth for the copy shipped inside the wheel
    here = os.path.dirname(os.path.abspath(__file__))
    ref = os.path.join(here, '..', '..', 'tgame_build', 'runtime.js')
    if not os.path.exists(ref):
        pytest.skip('not inside the tgame monorepo')
    shipped = os.path.join(here, '..', 'src', 'tgame', '_data', 'runtime.js')
    with open(ref, encoding='utf-8', newline='') as a, open(shipped, encoding='utf-8', newline='') as b:
        assert a.read().replace('\r\n', '\n') == b.read().replace('\r\n', '\n'), 'run: copy tgame_build/runtime.js to tgame-py/src/tgame/_data/runtime.js'

