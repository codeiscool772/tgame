"""Command line: `tgame game.tgame` plays; `tgame check|info|run|html|json|rename ...` for the rest."""
import argparse
import os
import sys

from . import __version__
from .game import Game

COMMANDS = ("play", "check", "info", "run", "html", "json", "rename")


def _load(path):
    try:
        return Game.load(path)
    except OSError as e:
        sys.stderr.write("tgame: cannot read %s: %s\n" % (path, e.strerror or e))
        raise SystemExit(2)


def _cmd_play(a):
    game = _load(a.file)
    return game.play(seed=a.seed, effects=False if a.no_effects else None,
                     save_dir=a.save_dir, load=a.load)


def _cmd_check(a):
    worst = 0
    for path in a.files:
        game = _load(path)
        problems = game.lint()
        for p in problems:
            print("%s:%d: %s: %s" % (path, p.n, p.sev, p.msg))
        errs = sum(1 for p in problems if p.is_error)
        warns = len(problems) - errs
        if not problems:
            print("%s: ok" % path)
        if errs or (a.strict and warns):
            worst = 1
    return worst


def _cmd_info(a):
    game = _load(a.file)
    if a.json:
        print(game.to_json())
        return 0
    s = game.stats()
    print("%s%s" % (s["title"] or os.path.basename(a.file), (" by " + s["author"]) if s["author"] else ""))
    print("  format %s · %d passages · %d words" % (s["format"] if s["format"] is not None else "?", s["passages"], s["words"]))
    print("  endings: %s" % (", ".join(s["endings"]) or "none"))
    if s["unreachable"]:
        print("  unreachable: %s" % ", ".join(s["unreachable"]))
    print("  %d error(s), %d warning(s)" % (s["errors"], s["warnings"]))
    return 1 if s["errors"] else 0


def _cmd_run(a):
    game = _load(a.file)
    inputs = [int(i) - 1 if i.isdigit() and a.numbers else i for i in a.input]
    res = game.run(inputs, seed=a.seed)
    for line in res.plain:
        print(line)
        print()
    if res.error:
        print("*** " + res.error)
        return 1
    if res.ended:
        print("— The End —")
    elif res.waiting == "choice":
        print("(waiting for a choice)")
        for i, c in enumerate(res.choices):
            print("  %d. %s" % (i + 1, c))
    elif res.waiting == "input":
        print("(waiting for an answer)")
    return 0


def _cmd_html(a):
    game = _load(a.file)
    if not game.ok:
        for p in game.errors:
            sys.stderr.write("%s:%d: error: %s\n" % (a.file, p.n, p.msg))
        sys.stderr.write("tgame: not exporting a game with errors\n")
        return 1
    out = a.output or os.path.splitext(a.file)[0] + ".html"
    with open(out, "w", encoding="utf-8") as f:
        f.write(game.to_html())
    print("wrote " + out)
    return 0


def _cmd_json(a):
    game = _load(a.file)
    text = game.to_json()
    if a.output:
        with open(a.output, "w", encoding="utf-8") as f:
            f.write(text)
        print("wrote " + a.output)
    else:
        print(text)
    return 0


def _cmd_rename(a):
    game = _load(a.file)
    try:
        n = game.rename_passage(a.old, a.new)
    except (KeyError, ValueError) as e:
        sys.stderr.write("tgame: %s\n" % (e.args[0] if e.args else e))
        return 1
    game.save()
    print("renamed %s -> %s (%d line(s) changed)" % (a.old, a.new, n))
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="tgame", description="Play and manipulate .tgame text adventures.")
    p.add_argument("--version", action="version", version="tgame " + __version__)
    sub = p.add_subparsers(dest="cmd", metavar="command")

    s = sub.add_parser("play", help="play a game in the terminal (the default: `tgame game.tgame`)")
    s.add_argument("file")
    s.add_argument("--seed", type=int, help="fix the random seed")
    s.add_argument("--no-effects", action="store_true", help="no typewriter or pauses")
    s.add_argument("--load", action="store_true", help="resume the saved game")
    s.add_argument("--save-dir", help="where saves go (default: ~/.tgame/saves)")
    s.set_defaults(fn=_cmd_play)

    s = sub.add_parser("check", help="lint one or more files (exit 1 on errors)")
    s.add_argument("files", nargs="+")
    s.add_argument("--strict", action="store_true", help="treat warnings as failures too")
    s.set_defaults(fn=_cmd_check)

    s = sub.add_parser("info", help="summarise a game")
    s.add_argument("file")
    s.add_argument("--json", action="store_true", help="full structure as JSON")
    s.set_defaults(fn=_cmd_info)

    s = sub.add_parser("run", help="run non-interactively with scripted answers and print the transcript")
    s.add_argument("file")
    s.add_argument("-i", "--input", action="append", default=[], metavar="ANSWER",
                   help="a choice (its text, or a number with -n) or a typed answer; repeat for more")
    s.add_argument("-n", "--numbers", action="store_true", help="treat all-digit inputs as 1-based choice numbers")
    s.add_argument("--seed", type=int)
    s.set_defaults(fn=_cmd_run)

    s = sub.add_parser("html", help="export a single self-contained HTML page")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(fn=_cmd_html)

    s = sub.add_parser("json", help="dump the game's structure as JSON")
    s.add_argument("file")
    s.add_argument("-o", "--output")
    s.set_defaults(fn=_cmd_json)

    s = sub.add_parser("rename", help="rename a passage and every reference to it (edits the file)")
    s.add_argument("file")
    s.add_argument("old")
    s.add_argument("new")
    s.set_defaults(fn=_cmd_rename)
    return p


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if argv and argv[0] not in COMMANDS and not argv[0].startswith("-"):
        argv.insert(0, "play")                     # `tgame game.tgame`
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "fn", None):
        parser.print_help()
        return 0
    try:
        return args.fn(args) or 0
    except KeyboardInterrupt:
        print()
        return 130


if __name__ == "__main__":
    sys.exit(main())
