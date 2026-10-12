"""Terminal player."""
import json
import os
import re
import shutil
import sys
import textwrap
import time

from .core import Interp, match_choice, fmt_ansi, strip_marks
from ._js import hash_str

_HELP_EXTRA = "Also: undo · save · load · quit"


def _slug(s):
    return re.sub(r"[^\w-]+", "_", s.strip()).strip("_") or "untitled"


class TerminalPlayer(object):
    def __init__(self, game, seed=None, effects=None, save_dir=None, input_fn=None, out=None,
                 width=None, load=False):
        self.game = game
        self.parsed = game.parsed
        self.out = out or sys.stdout
        self.input_fn = input_fn or input
        tty = bool(getattr(self.out, "isatty", lambda: False)())
        self.effects = tty if effects is None else bool(effects)
        self.color = tty and not os.environ.get("NO_COLOR")
        self.width = width or min(shutil.get_terminal_size((80, 24)).columns - 2, 78)
        self.seed = seed
        self.load_first = load
        self.save_dir = save_dir or os.path.join(
            os.environ.get("TGAME_HOME") or os.path.join(os.path.expanduser("~"), ".tgame"), "saves")
        self.history = []
        self.interp = None

    # ------------------------------------------------------------------ output
    def say(self, s=""):
        self.out.write(s + "\n")
        self.out.flush()

    def _style(self, code, s):
        return "\x1b[%sm%s\x1b[0m" % (code, s) if self.color else s

    def _wrap(self, text):
        parts = text.split("\n")
        return "\n".join(textwrap.fill(p, self.width, replace_whitespace=False, drop_whitespace=True)
                         if p.strip() else p for p in parts)

    def show(self, ev):
        if ev.style == "pre":
            self.say(ev.text)
            self.say()
            return
        raw = ev.raw if ev.raw is not None else ev.text
        if ev.style == "sys":
            self.say(self._style("2", self._wrap(strip_marks(raw))))
            return
        wrapped = self._wrap(raw)
        shown = fmt_ansi(wrapped) if self.color else strip_marks(wrapped)
        if ev.style == "prompt":
            shown = self._style("33", shown)
        if ev.typewriter and self.effects:
            try:
                for ch in shown:
                    self.out.write(ch)
                    self.out.flush()
                    time.sleep(ev.speed / 1000.0)
                self.out.write("\n")
            except KeyboardInterrupt:
                self.out.write("\n")
        else:
            self.say(shown)
        self.say()

    def show_choices(self, choices):
        for i, c in enumerate(choices):
            self.say("  %s %s" % (self._style("2", "%d." % (i + 1)), c.label))
        self.say()

    def ask(self, prompt="> "):
        try:
            return self.input_fn(prompt)
        except EOFError:
            return None
        except KeyboardInterrupt:
            self.say()
            return None

    # ------------------------------------------------------------------ saves
    def _save_path(self):
        name = self.game.title or (os.path.splitext(os.path.basename(self.game.path))[0] if self.game.path else "")
        return os.path.join(self.save_dir, _slug(name) + ".json")

    def _write_save(self):
        try:
            os.makedirs(self.save_dir, exist_ok=True)
            with open(self._save_path(), "w", encoding="utf-8") as f:
                json.dump({"v": 1, "title": self.game.title, "seed": self.interp.seed,
                           "hash": hash_str(self.game.source), "history": self.history}, f)
            self.say(self._style("2", "Game saved."))
        except OSError as e:
            self.say("Could not save: %s" % e)

    def _read_save(self):
        try:
            with open(self._save_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            self.say(self._style("2", "No saved game found."))
            return None
        if not isinstance(d, dict) or d.get("v") != 1 or not isinstance(d.get("history"), list):
            self.say("Not a valid saved game.")
            return None
        if d.get("hash") and d["hash"] != hash_str(self.game.source):
            self.say(self._style("2", "Note: the story changed since this save, so it may not line up."))
        return d

    # ------------------------------------------------------------------ main loop
    def run(self):
        errs = self.game.errors
        if errs:
            for e in errs:
                self.say("%s: %s" % (self.game.path or "game", e))
            self.say("Fix the errors above first (see: tgame check).")
            return 1
        seed, replay = self.seed, None
        if self.load_first:
            d = self._read_save()
            if d:
                seed, replay = d.get("seed"), d["history"]
        while True:
            outcome = self._session(seed, replay)
            if outcome[0] == "restart":
                _, seed, replay = outcome
                continue
            return 0

    def _session(self, seed, replay):
        interp = Interp(self.parsed, skip_effects=(not self.effects) or bool(replay), seed=seed)
        self.interp = interp
        self.history = []
        rq = list(replay) if replay is not None else None
        buf = []
        gen = interp.run()
        try:
            ev = next(gen)
            while True:
                t = ev.type
                if t == "text":
                    if rq is not None:
                        buf.append(ev)
                    else:
                        self.show(ev)
                    ev = gen.send(None)
                elif t == "pause":
                    if self.effects:
                        time.sleep(ev.ms / 1000.0)
                    ev = gen.send(None)
                elif t == "end":
                    self.say(self._style("2", "— The End —"))
                    return ("done",)
                elif t == "error":
                    self.say("*** " + ev.text)
                    self.say(self._style("2", "— The End —"))
                    return ("done",)
                elif t in ("input", "choice"):
                    if rq:
                        e = rq.pop(0)
                        if t == "input" and e.get("t") == "i":
                            self.history.append(e)
                            buf = []
                            ev = gen.send(e["v"])
                            continue
                        if (t == "choice" and e.get("t") == "c" and isinstance(e.get("i"), int)
                                and 0 <= e["i"] < len(ev.choices)):
                            self.history.append(e)
                            buf = []
                            ev = gen.send(e["i"])
                            continue
                        self.say("*** the save no longer matches this story")
                        return ("done",)
                    if rq is not None:               # replay finished: show where we are
                        for b in buf:
                            self.show(b)
                        buf, rq = [], None
                        interp.skip_effects = not self.effects
                    if t == "input":
                        ans = self.ask("> ")
                        if ans is None:
                            return ("done",)
                        self.history.append({"t": "i", "v": ans})
                        ev = gen.send(ans)
                    else:
                        r = self._choose(ev)
                        if r[0] == "pick":
                            self.history.append({"t": "c", "i": r[1]})
                            ev = gen.send(r[1])
                        else:
                            return r
        except StopIteration:
            return ("done",)

    def _choose(self, ev):
        if not ev.parser_mode:
            self.show_choices(ev.choices)
        while True:
            line = self.ask("> ")
            if line is None:
                return ("done",)
            cmd = line.strip().lower()
            if not cmd:
                continue
            if cmd in ("quit", "exit"):
                return ("done",)
            if cmd in ("help", "?"):
                self.say("Commands available here:")
                for i, c in enumerate(ev.choices):
                    extra = "   (%s)" % ", ".join(c.aliases) if c.aliases else ""
                    self.say("  %d  %s%s" % (i + 1, c.label, extra))
                self.say(_HELP_EXTRA)
                continue
            if cmd == "undo":
                if not self.history:
                    self.say(self._style("2", "Nothing to undo."))
                    continue
                return ("restart", self.interp.seed, self.history[:-1])
            if cmd == "save":
                self._write_save()
                continue
            if cmd in ("load", "restore"):
                d = self._read_save()
                if d:
                    return ("restart", d.get("seed"), d["history"])
                continue
            kind, val = match_choice(line, ev.choices, self.parsed.ignore)
            if kind == "index":
                return ("pick", val)
            if kind == "ambiguous":
                self.say(self._style("2", "Which do you mean? " + " / ".join(ev.choices[i].label for i in val)))
            else:
                self.say(self._style("2", "I don't understand \"%s\"." % line.strip()))


def play(game, **kw):
    """Play a Game in the terminal. Returns an exit status (0 ok).

    Options: seed, effects (typewriter/pauses; default: only on a real terminal),
    save_dir, load (resume the saved game), input_fn, out, width.
    """
    return TerminalPlayer(game, **kw).run()
