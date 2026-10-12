"""The friendly layer: load a .tgame, inspect it, lightly edit it, run it, export it."""
import json
import os
import pkgutil
import re

from .core import (TGAME_FORMAT, TgameError, Interp, parse, classify_line, split_choice,
                   parse_prompt_line, match_choice, esc_html, strip_marks, NAME_FULL)
from ._js import hash_str
from .lint import lint as _lint


def _clean(v):
    """3.0 -> 3, so values read naturally from Python."""
    if isinstance(v, float) and v == v and abs(v) != float("inf") and v == int(v):
        return int(v)
    return v


class PassageInfo(object):
    """A read-only view of one passage."""
    def __init__(self, game, p, end_line):
        self._game, self._p = game, p
        self.name, self.line, self.tags = p.name, p.n, list(p.tags)
        self._end = end_line

    @property
    def text(self):
        """The passage's source text, including its :: header line."""
        lines = self._game._lines()
        return "\n".join(lines[self.line - 1:self._end])

    @property
    def links(self):
        """Names of the passages this one can lead to (choices, ->, >>, ? targets)."""
        seen, out = set(), []
        for item in self._p.lines:
            k = classify_line(item)
            tgt = None
            if k.kind in ("jump", "call"):
                tgt = k.target
            elif k.kind == "input":
                spec = parse_prompt_line(item.text)
                tgt = spec.target if spec else None
            elif k.kind == "choice":
                tgt = split_choice(item.text)[1]
            if tgt and tgt.upper() != "END" and tgt.lower() not in seen:
                seen.add(tgt.lower())
                out.append(tgt)
        return out

    @property
    def is_ending(self):
        """True if the passage ends the game: an explicit END, or no way out."""
        if self._p.is_snippet:
            return False
        has_exit = False
        for item in self._p.lines:
            k = classify_line(item)
            if k.kind == "jump":
                if k.target.upper() == "END":
                    return True
                has_exit = True
            elif k.kind == "input":
                spec = parse_prompt_line(item.text)
                if spec and spec.target:
                    if spec.target.upper() == "END":
                        return True
                    has_exit = True
            elif k.kind == "choice":
                tgt = split_choice(item.text)[1]
                if tgt and tgt.upper() == "END":
                    return True
                has_exit = True
        return not has_exit

    def __repr__(self):
        return "<Passage %s line %d>" % (self.name, self.line)


class RunResult(object):
    """What a headless run produced."""
    def __init__(self):
        self.lines = []          # narration, in order (with *italic* / **bold** markers, as the reference runtime emits)
        self.plain = []          # the same, markers stripped
        self.ended = False
        self.error = None
        self.waiting = None      # 'choice', 'input' or None
        self.choices = []        # labels offered if waiting == 'choice'
        self.prompt = None
        self.vars = {}
        self.inventory = []
        self.lists = {}
        self.seed = 0
        self.history = []        # [{'t':'c','i':n} | {'t':'i','v':'text'}] — a replayable save

    @property
    def text(self):
        return "\n\n".join(self.lines)

    def __repr__(self):
        state = "ended" if self.ended else ("error" if self.error else "waiting for " + str(self.waiting))
        return "<RunResult %d lines, %s>" % (len(self.lines), state)


class Game(object):
    """A .tgame file in memory.

        g = tgame.load("cave.tgame")
        g.play()                     # run it in the terminal
        g.run([0, "take lamp"])      # run it headlessly
        g.lint()                     # list of problems
    """

    def __init__(self, source, path=None):
        self.path = path
        self._source = source
        self._parsed = None
        self._problems = None

    # ------------------------------------------------------------- loading / saving
    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            return cls(f.read(), path=str(path))

    @classmethod
    def loads(cls, source):
        return cls(source)

    def save(self, path=None):
        """Write the source back out (to `path`, or over the file it was loaded from)."""
        path = path or self.path
        if not path:
            raise ValueError("no path given and this game wasn't loaded from a file")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(self._source)
        self.path = str(path)
        return self.path

    @property
    def source(self):
        return self._source

    @source.setter
    def source(self, value):
        self._source = value
        self._parsed = self._problems = None

    @property
    def parsed(self):
        if self._parsed is None:
            self._parsed = parse(self._source)
        return self._parsed

    # ------------------------------------------------------------- inspecting
    @property
    def title(self):
        return self.parsed.meta.get("title", "")

    @property
    def author(self):
        return self.parsed.meta.get("author", "")

    @property
    def start(self):
        g = self.parsed
        return g.passages[g.meta["start"].lower()].name if g.meta.get("start", "").lower() in g.passages \
            else (g.order[0].name if g.order else None)

    @property
    def format(self):
        return self.parsed.format

    @property
    def meta(self):
        return dict(self.parsed.meta)

    @property
    def passages(self):
        g = self.parsed
        total = len(self._lines())
        out = []
        for i, p in enumerate(g.order):
            end = (g.order[i + 1].n - 1) if i + 1 < len(g.order) else total
            out.append(PassageInfo(self, p, end))
        self._mark_snippets()
        return out

    def passage(self, name):
        for p in self.passages:
            if p.name.lower() == str(name).lower():
                return p
        raise KeyError(name)

    def __contains__(self, name):
        return str(name).lower() in self.parsed.passages

    def __len__(self):
        return len(self.parsed.order)

    def _mark_snippets(self):
        g = self.parsed
        targets = set()
        for p in g.order:
            for item in p.lines:
                k = classify_line(item)
                if k.kind == "call":
                    targets.add(k.target.lower())
        for p in g.order:
            p.is_snippet = p.key in targets

    def lint(self):
        """All problems found (errors and warnings), sorted by line."""
        if self._problems is None:
            self._problems = _lint(self.parsed)
        return list(self._problems)

    problems = lint

    @property
    def errors(self):
        return [p for p in self.lint() if p.is_error]

    @property
    def ok(self):
        """True if the game has no errors (warnings are fine)."""
        return not self.errors

    def stats(self):
        ps = self.passages
        reach = self._reachable()
        return {
            "title": self.title,
            "author": self.author,
            "format": self.format,
            "passages": len(ps),
            "endings": [p.name for p in ps if p.is_ending],
            "unreachable": [p.name for p in ps if p.name.lower() not in reach],
            "words": len(self._source.split()),
            "errors": len(self.errors),
            "warnings": len(self.lint()) - len(self.errors),
        }

    def _reachable(self):
        g = self.parsed
        if not g.order:
            return set()
        root = (g.meta.get("start") or g.order[0].key).lower()
        links = dict((p.name.lower(), [l.lower() for l in p.links]) for p in self.passages)
        seen, stack = set(), [root]
        while stack:
            k = stack.pop()
            if k in seen or k not in links:
                continue
            seen.add(k)
            stack.extend(links[k])
        return seen

    def to_dict(self):
        """Everything about the game as plain data (for json.dumps)."""
        g = self.parsed
        return {
            "format": g.format,
            "meta": dict(g.meta),
            "start": self.start,
            "lists": dict((k, list(v)) for k, v in g.lists.items() if k != "inventory"),
            "variables": dict((k, _clean(v)) for k, v in g.vars.items()),
            "passages": [{"name": p.name, "line": p.line, "tags": p.tags, "links": p.links,
                          "ending": p.is_ending, "text": p.text} for p in self.passages],
            "problems": [{"severity": p.sev, "line": p.n, "message": p.msg} for p in self.lint()],
        }

    def to_json(self, **kw):
        kw.setdefault("indent", 2)
        kw.setdefault("ensure_ascii", False)
        return json.dumps(self.to_dict(), **kw)

    # ------------------------------------------------------------- light editing
    def _nl(self):
        return "\r\n" if "\r\n" in self._source else "\n"

    def _lines(self):
        return re.split(r"\r?\n", self._source)

    def _set_lines(self, lines):
        self.source = self._nl().join(lines)

    def set_meta(self, key, value):
        """Set a header directive such as title, author or start (adds it if missing)."""
        key = key.lower().lstrip("@")
        lines = self._lines()
        pat = re.compile(r"^\s*@" + re.escape(key) + r"(\s|$)", re.I)
        first_passage = next((i for i, l in enumerate(lines) if re.match(r"^\s*::", l)), len(lines))
        for i in range(first_passage):
            if pat.match(lines[i]):
                lines[i] = "@%s %s" % (key, value)
                self._set_lines(lines)
                return
        last = -1
        for i in range(first_passage):
            if re.match(r"^\s*@\w+", lines[i]):
                last = i
        lines.insert(last + 1, "@%s %s" % (key, value))
        self._set_lines(lines)

    def rename_passage(self, old, new):
        """Rename a passage and update everything that points at it. Returns how many lines changed."""
        g = self.parsed
        okey = str(old).lower()
        if okey not in g.passages:
            raise KeyError(old)
        if not NAME_FULL.match(new) or new.lower() == "end":
            raise ValueError('"%s" is not a valid passage name' % new)
        if new.lower() != okey and new.lower() in g.passages:
            raise ValueError('a passage called "%s" already exists' % new)
        lines = self._lines()
        before = list(lines)
        o = re.escape(str(old))
        head = g.passages[okey]
        lines[head.n - 1] = re.sub(r"^(\s*::\s*)\S+", lambda m: m.group(1) + new, lines[head.n - 1], count=1)
        visited = re.compile(r"(\bvisited\s+)" + o + r"(?![\w-])", re.I)
        target_end = re.compile(r"^(\s*(?:->|>>)\s*)" + o + r"(\s*)$", re.I)
        target_mid = re.compile(r"(->\s*)" + o + r"(\s*(?:\[.*\])?\s*$)", re.I)
        for p in g.order:
            for item in p.lines:
                if item.blank or item.verbatim is not None or item.literal:
                    continue
                i = item.n - 1
                k = classify_line(item)
                line = lines[i]
                if k.kind in ("jump", "call"):
                    line = target_end.sub(lambda m: m.group(1) + new + m.group(2), line)
                elif k.kind in ("choice", "input"):
                    line = target_mid.sub(lambda m: m.group(1) + new + m.group(2), line)
                if k.kind in ("if", "effect"):
                    line = visited.sub(lambda m: m.group(1) + new, line)
                elif k.kind not in ("jump", "call"):
                    line = re.sub(r"\{[^{}]*\}", lambda m: visited.sub(lambda mm: mm.group(1) + new, m.group(0)), line)
                lines[i] = line
        start = re.compile(r"^(\s*@start\s+)" + o + r"(\s*)$", re.I)
        for i in range(head.n if False else 0, len(lines)):
            lines[i] = start.sub(lambda m: m.group(1) + new + m.group(2), lines[i])
        changed = sum(1 for a, b in zip(before, lines) if a != b)
        self._set_lines(lines)
        return changed

    def add_passage(self, name, text="", tags=()):
        """Append a passage."""
        if not NAME_FULL.match(name) or name.lower() == "end":
            raise ValueError('"%s" is not a valid passage name' % name)
        if name in self:
            raise ValueError('a passage called "%s" already exists' % name)
        header = ":: " + name + "".join(" #" + t.lstrip("#") for t in tags)
        body = text.strip("\n")
        add = ["", header] + (body.split("\n") if body else [])
        lines = self._lines()
        if lines and lines[-1] == "":
            lines.pop()
        self._set_lines(lines + add + [""])

    def remove_passage(self, name):
        """Delete a passage. Returns the names of passages that still link to it."""
        info = self.passage(name)
        lines = self._lines()
        lo, hi = info.line - 1, info._end
        while lo > 0 and lines[lo - 1].strip() == "":
            lo -= 1
        del lines[lo:hi]
        self._set_lines(lines)
        key = str(name).lower()
        return [p.name for p in self.passages if key in [l.lower() for l in p.links]]

    # ------------------------------------------------------------- running
    def interpreter(self, seed=None, skip_effects=False):
        """A raw Interp for this game (call .run() for the event generator)."""
        return Interp(self.parsed, skip_effects=skip_effects, seed=seed)

    def run(self, inputs=(), seed=None, replay=None):
        """Run headlessly. `inputs` answers choices (an index or typed text) and `?` questions in order.

        Stops when the game ends, errors, or runs out of inputs (then `.waiting` says what it wants).
        """
        errs = self.errors
        res = RunResult()
        if errs:
            res.error = "; ".join(str(e) for e in errs[:3])
            return res
        interp = Interp(self.parsed, skip_effects=True, seed=seed)
        res.seed = interp.seed
        gen = interp.run()
        queue = list(inputs)
        try:
            ev = next(gen)
            while True:
                t = ev.type
                if t == "text":
                    res.lines.append(ev.text)
                    res.plain.append(ev.text if ev.style == "pre" else strip_marks(ev.raw))
                    ev = gen.send(None)
                elif t == "pause":
                    ev = gen.send(None)
                elif t == "end":
                    res.ended = True
                    break
                elif t == "error":
                    res.error = ev.text
                    break
                elif t == "input":
                    if not queue:
                        res.waiting, res.prompt = "input", ev.prompt
                        break
                    ans = str(queue.pop(0))
                    res.history.append({"t": "i", "v": ans})
                    ev = gen.send(ans)
                elif t == "choice":
                    if not queue:
                        res.waiting = "choice"
                        res.choices = [c.label for c in ev.choices]
                        break
                    a = queue.pop(0)
                    if isinstance(a, int) and not isinstance(a, bool):
                        idx = a
                    else:
                        kind, val = match_choice(str(a), ev.choices, self.parsed.ignore)
                        if kind != "index":
                            res.error = "%s choice for %r (options: %s)" % (
                                "ambiguous" if kind == "ambiguous" else "no matching", a,
                                ", ".join(c.label for c in ev.choices))
                            break
                        idx = val
                    res.history.append({"t": "c", "i": idx})
                    ev = gen.send(idx)
        except StopIteration:
            res.ended = res.error is None
        res.vars = dict((k, _clean(v)) for k, v in interp.vars.items())
        res.lists = dict((k, list(v)) for k, v in interp.lists.items())
        res.inventory = list(interp.lists.get("inventory", []))
        return res

    def play(self, **kw):
        """Play it in the terminal. See tgame.player.play for the options."""
        from .player import play
        return play(self, **kw)

    # ------------------------------------------------------------- exporting
    def to_html(self):
        """A single self-contained HTML page that plays the game (no network, no dependencies)."""
        runtime = pkgutil.get_data("tgame", "_data/runtime.js").decode("utf-8")
        runtime = re.sub(r"</script", r"<\\/script", runtime, flags=re.I)
        src_lit = (json.dumps(self._source, ensure_ascii=False).replace("</", "<\\/")
                   .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
        boot = (
            "var SOURCE = " + src_lit + ";\n"
            "(function(){\n"
            "  var game = parse(SOURCE);\n"
            "  var player = new TgamePlayer({\n"
            '    out: document.getElementById("out"),\n'
            '    choices: document.getElementById("choices"),\n'
            '    form: document.getElementById("form"),\n'
            '    input: document.getElementById("cmd"),\n'
            '    scroll: function(){ window.scrollTo(0, document.body.scrollHeight); }\n'
            "  });\n"
            '  document.title = game.meta.title || "tgame";\n'
            "  player.start(game, { hash: " + json.dumps(hash_str(self._source)) + " });\n"
            "})();\n")
        return _HTML_SHELL.replace("{{TITLE}}", esc_html(self.title or "tgame")) \
                          .replace("{{SCRIPT}}", runtime + "\n" + boot)

    def __repr__(self):
        return "<Game %r, %d passages>" % (self.title or (self.path or "untitled"), len(self.parsed.order))


_HTML_SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<style>
html,body{margin:0;background:#1e1e1e;color:#d4d4d4;
  font:15px/1.75 ui-monospace,Menlo,Monaco,Consolas,monospace}
body{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 6rem}
#out p{margin:0 0 .85em;white-space:pre-wrap}
#out pre.pre{margin:0 0 .85em;white-space:pre;overflow-x:auto;font:inherit;line-height:1.3}
#out p.echo{color:#9cdcfe;opacity:.6;margin-bottom:.35em}
#out p.err{color:#f48771}
#out p.sys{color:#6a9955;font-style:italic}
#out p.end{color:#ce9178;font-style:italic;text-align:center}
#out p.prompt{color:#d99058;font-style:italic}
#out em{color:#9cdcfe;font-style:italic}
#out strong{color:#e7e7e7;font-weight:600}
#choices{list-style:none;padding:0;margin:.8em 0 0}
#choices button{background:none;border:0;color:#d99058;font:inherit;
  cursor:pointer;padding:.2em 0;text-align:left;display:flex;gap:.8em;width:100%}
#choices button:hover,#choices button:focus-visible{color:#e6a56f;text-decoration:underline}
#choices .num{color:#8a8a8a}
#form{margin-top:1.6em}
#cmd{width:100%;box-sizing:border-box;background:#3c3c3c;border:1px solid #3c3c3c;color:#e7e7e7;
  font:inherit;padding:.55em .75em;border-radius:3px;outline:0}
#cmd:focus{border-color:#d99058}
#form.awaiting #cmd{border-color:#d99058;box-shadow:0 0 0 1px #d99058}
</style>
</head>
<body>
<main id="out" role="log" aria-live="polite" aria-label="Story"></main>
<ul id="choices" aria-label="Choices"></ul>
<form id="form"><input id="cmd" aria-label="Command" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="type a command…"></form>
<script>
{{SCRIPT}}</script>
</body>
</html>"""


def load(path):
    """Load a .tgame file."""
    return Game.load(path)


def loads(source):
    """Load a game from a string."""
    return Game.loads(source)
