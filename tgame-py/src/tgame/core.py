"""tgame core: parser, expression evaluator, interpreter.

A faithful port of the reference JavaScript runtime (format 3).  The interpreter
is a generator that yields events (see `Event`); everything else is built on it.
"""
import math
import re
import random as _random
import time

from ._js import (mulberry32, to_int32, to_num, num_or0, truthy, js_str, loose_eq,
                  compare, js_add, js_div, js_mod, hash_str)

TGAME_FORMAT = 3


class TgameError(Exception):
    """A problem in a game's source or while running it."""


class Event(object):
    """Something the interpreter wants the player to do or show.

    type is one of: text, pause, input, choice, end, error.
    """
    def __init__(self, type, **kw):
        self.type = type
        self.text = kw.pop("text", None)
        self.html = kw.pop("html", None)
        self.raw = kw.pop("raw", None)
        self.style = kw.pop("style", None)
        self.typewriter = kw.pop("typewriter", False)
        self.speed = kw.pop("speed", 30)
        self.ms = kw.pop("ms", 0)
        self.var_name = kw.pop("var_name", None)
        self.prompt = kw.pop("prompt", None)
        self.vtype = kw.pop("vtype", None)
        self.choices = kw.pop("choices", None)
        self.passage = kw.pop("passage", None)
        self.parser_mode = kw.pop("parser_mode", False)
        if kw:
            raise TypeError("unknown event fields: %s" % ", ".join(kw))

    def __repr__(self):
        bits = [self.type]
        for k in ("text", "ms", "passage"):
            v = getattr(self, k)
            if v not in (None, 0):
                bits.append("%s=%r" % (k, v))
        return "Event(%s)" % ", ".join(bits)


class Problem(object):
    """One lint finding."""
    def __init__(self, sev, n, msg):
        self.sev, self.n, self.msg = sev, n, msg

    @property
    def is_error(self):
        return self.sev == "error"

    def __repr__(self):
        return "Problem(%r, line %d, %r)" % (self.sev, self.n, self.msg)

    def __str__(self):
        return "line %d: %s: %s" % (self.n, self.sev, self.msg)


# identifiers are Unicode: letters, digits, underscore (not starting with a digit)
ID = r"[^\W\d]\w*"
ID_FULL = re.compile(r"^" + ID + r"$")
NAME_FULL = re.compile(r"^[\w-]+$")
WORD_RE = re.compile(r"^\w")

# ---------------------------------------------------------------- escapes
ESC_SET = "\\*?:@[]{}|>-~./`#"
ESC_TO_PH = {ch: chr(0xE000 + i) for i, ch in enumerate(ESC_SET)}
PH_TO_ESC = {v: k for k, v in ESC_TO_PH.items()}
_ESC_RE = re.compile(r"\\(.?)", re.S)
_PH_RE = re.compile("[\uE000-\uE0FF]")


def escape_line(line):
    def sub(m):
        ch = m.group(1)
        if ch == "":
            return "\\"                      # trailing backslash = hard line break
        return ESC_TO_PH.get(ch, ch)
    return _ESC_RE.sub(sub, line)


def unescape_text(text):
    return _PH_RE.sub(lambda m: PH_TO_ESC.get(m.group(0), m.group(0)), text)


def esc_html(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&#39;"))


def fmt_html(s):
    h = esc_html(s)
    h = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", h)
    h = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", h)
    return unescape_text(h)


def fmt_ansi(s):
    h = re.sub(r"\*\*([^*]+)\*\*", "\x1b[1m\\1\x1b[22m", s)
    h = re.sub(r"\*([^*]+)\*", "\x1b[3m\\1\x1b[23m", h)
    return unescape_text(h)


def strip_marks(s):
    h = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    h = re.sub(r"\*([^*]+)\*", r"\1", h)
    return unescape_text(h)


# ---------------------------------------------------------------- utilities
def split_top_level(s, seps, quotes=False):
    parts, cur, depth, q, i, n = [], [], 0, None, 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            cur.append(c + s[i + 1])
            i += 2
            continue
        if quotes:
            if q:
                cur.append(c)
                if c == q:
                    q = None
                i += 1
                continue
            if c in "\"'" and (i == 0 or not (s[i - 1].isalnum() or s[i - 1] == "_")):
                q = c
                cur.append(c)
                i += 1
                continue
        if c in "([{":
            depth += 1
            cur.append(c)
            i += 1
            continue
        if c in ")]}":
            depth -= 1
            cur.append(c)
            i += 1
            continue
        if depth == 0:
            hit = None
            for sep in seps:
                if s.startswith(sep, i):
                    hit = sep
                    break
            if hit is not None:
                parts.append("".join(cur))
                cur = []
                i += len(hit)
                continue
        cur.append(c)
        i += 1
    parts.append("".join(cur))
    return parts


def list_has(lst, name):
    n = str(name).lower()
    return any(str(x).lower() == n for x in (lst or []))


def list_index(lst, name):
    n = str(name).lower()
    for i, x in enumerate(lst):
        if str(x).lower() == n:
            return i
    return -1


# ---------------------------------------------------------------- line parsers
PROMPT_BARE_RE = re.compile(r"^\?\s+(" + ID + r")(?::(text|number))?\s*(?:->\s*(\S+))?\s*$")
PROMPT_INLINE_RE = re.compile(r"^\?\s+(.+?)(?:\s*\[(" + ID + r")(?::(text|number))?\])?\s*(?:->\s*(\S+))?\s*$")
PAUSE_RE = re.compile(r"^\.\.\.\s*(\d+(?:\.\d+)?)?\s*(ms|s)?\s*$")
MODE_RE = re.compile(r"^~(\w+)\s*$")
MODES = ("type", "normal", "fast", "slow")


class Prompt(object):
    def __init__(self, prompt, var_name, vtype, target):
        self.prompt, self.var_name, self.vtype, self.target = prompt, var_name, vtype, target


def parse_prompt_line(text):
    m = PROMPT_BARE_RE.match(text)
    if m:
        return Prompt(None, m.group(1), m.group(2), m.group(3))
    m = PROMPT_INLINE_RE.match(text)
    if m:
        prompt = m.group(1).strip()
        if not prompt:
            return None
        return Prompt(prompt, m.group(2), m.group(3), m.group(4))
    return None


def parse_pause_line(text):
    m = PAUSE_RE.match(text)
    if not m:
        return None
    n = float(m.group(1)) if m.group(1) else 500.0
    ms = n * 1000 if m.group(2) == "s" else n
    return max(0, int(ms + 0.5))


def parse_mode_line(text):
    m = MODE_RE.match(text)
    if not m:
        return None
    mode = m.group(1).lower()
    return mode if mode in MODES else None


class Kind(object):
    __slots__ = ("kind", "cond", "ms", "mode", "target", "src")

    def __init__(self, kind, **kw):
        self.kind = kind
        self.cond = kw.get("cond")
        self.ms = kw.get("ms")
        self.mode = kw.get("mode")
        self.target = kw.get("target")
        self.src = kw.get("src")


def classify_line(item):
    if item.blank:
        return Kind("blank")
    if item.verbatim is not None:
        return Kind("verbatim")
    if item.literal:
        return Kind("text")
    t = item.text
    if t.startswith("if ") and t.endswith(":"):
        return Kind("if", cond=t[3:-1].strip())
    if t == "else:":
        return Kind("else")
    if t == "end":
        return Kind("end")
    ms = parse_pause_line(t)
    if ms is not None:
        return Kind("pause", ms=ms)
    mode = parse_mode_line(t)
    if mode:
        return Kind("mode", mode=mode)
    if re.match(r"^~\w+\s*$", t):
        return Kind("badmode")
    if t[:1] == "?":
        return Kind("input")
    if t[:1] == "*":
        return Kind("choice")
    if t[:2] == "->":
        return Kind("jump", target=t[2:].strip())
    if t[:2] == ">>":
        return Kind("call", target=t[2:].strip())
    if t[:1] == "[" and t.endswith("]"):
        return Kind("effect", src=t[1:-1])
    return Kind("text")


# ---------------------------------------------------------------- parser
KNOWN_DIRECTIVES = ("title", "author", "start", "set", "var", "list", "seed", "parser",
                    "format", "typewriter", "ignore")


class Item(object):
    __slots__ = ("text", "raw", "n", "literal", "blank", "verbatim")

    def __init__(self, text="", raw="", n=0, literal=False, blank=False, verbatim=None):
        self.text, self.raw, self.n = text, raw, n
        self.literal, self.blank, self.verbatim = literal, blank, verbatim


class Passage(object):
    def __init__(self, name, n, tags):
        self.name, self.key, self.n, self.tags = name, name.lower(), n, tags
        self.lines = []
        self.is_snippet = False


class ParsedGame(object):
    def __init__(self):
        self.meta = {}
        self.vars = {}
        self.inits = []
        self.lists = {}
        self.seed = None
        self.parser_mode = False
        self.typewriter_enabled = False
        self.typewriter_speed = 30
        self.format = None
        self.ignore = ["the", "a", "an"]
        self.passages = {}
        self.order = []
        self.errors = []


def _err(game, sev, n, msg):
    game.errors.append(Problem(sev, n, msg))


def parse(src):
    game = ParsedGame()
    cur = None
    fence = None
    lines = re.split(r"\r?\n", src)

    for i, raw in enumerate(lines):
        n = i + 1
        if fence is not None:
            if re.match(r"^\s*```\s*$", raw):
                if cur is not None:
                    cur.lines.append(Item(text="", verbatim="\n".join(fence["lines"]), n=fence["n"]))
                fence = None
            else:
                fence["lines"].append(raw)
            continue
        if re.match(r"^\s*```\s*$", raw):
            if cur is None:
                _err(game, "error", n, "content outside of any passage")
            fence = {"n": n, "lines": []}
            continue

        rt = raw.lstrip()
        literal = rt[:1] == "\\"
        trimmed = escape_line(raw).lstrip()
        if not trimmed:
            if cur is not None and game.format != 2:
                cur.lines.append(Item(blank=True, n=n))
            continue
        if not literal and trimmed[:2] == "//":
            continue

        # ---- directives
        if not literal and trimmed[0] == "@":
            m = re.match(r"^@(\w+)\s*([\s\S]*)$", trimmed)
            if not m:
                _err(game, "error", n, "malformed directive")
                continue
            key, val = m.group(1).lower(), m.group(2).strip()
            if key not in KNOWN_DIRECTIVES:
                _err(game, "warn", n, "unknown directive @" + m.group(1))
            elif cur is not None:
                _err(game, "warn", n, "@%s inside a passage is still global — it applies from the start of the game. Move it above the first passage." % key)

            if key in ("set", "var"):
                eq = val.find("=")
                if eq < 0:
                    _err(game, "error", n, '@set needs "name = value"')
                    continue
                name = val[:eq].strip()
                if not ID_FULL.match(name):
                    _err(game, "error", n, '@set: bad name "%s"' % name)
                    continue
                expr_src = val[eq + 1:]
                try:
                    game.vars[name] = eval_expr(expr_src, Ctx(vars=dict(game.vars), lists={}, rng=lambda: 0.5))
                    game.inits.append((name, expr_src, n))
                except TgameError as e:
                    _err(game, "error", n, "@set: %s" % e)
            elif key == "list":
                if not ID_FULL.match(val):
                    _err(game, "error", n, '@list: bad name "%s"' % val)
                    continue
                game.lists.setdefault(val, [])
            elif key == "seed":
                m2 = re.match(r"^\s*([+-]?\d+)", val)
                if not m2:
                    _err(game, "error", n, "@seed needs a number")
                else:
                    game.seed = int(m2.group(1))
            elif key == "format":
                m2 = re.match(r"^\s*([+-]?\d+)", val)
                if not m2:
                    _err(game, "error", n, "@format needs a number")
                elif int(m2.group(1)) > TGAME_FORMAT:
                    _err(game, "error", n, "this file needs tgame format %s; this runtime supports up to %d"
                         % (m2.group(1), TGAME_FORMAT))
                else:
                    game.format = int(m2.group(1))
            elif key == "ignore":
                game.ignore = [w for w in re.split(r"[\s,]+", val.lower()) if w]
            elif key == "parser":
                game.parser_mode = True
            elif key == "typewriter":
                v = val.lower()
                if v == "off":
                    game.typewriter_enabled = False
                else:
                    game.typewriter_enabled = True
                    if v == "fast":
                        game.typewriter_speed = 15
                    elif v == "slow":
                        game.typewriter_speed = 60
                    elif re.match(r"^\d+$", v):
                        game.typewriter_speed = max(1, int(v))
                    else:
                        game.typewriter_speed = 30
            else:
                game.meta[key] = val
            continue

        # ---- passage header:  :: name #tag #tag
        if not literal and trimmed[:2] == "::":
            parts = trimmed[2:].strip().split()
            name = parts[0] if parts else ""
            if not name:
                _err(game, "error", n, "passage needs a name")
                continue
            tags = []
            for tok in parts[1:]:
                if tok[0] == "#" and len(tok) > 1:
                    tags.append(tok[1:])
                else:
                    _err(game, "error", n, 'unexpected "%s" after the passage name (tags look like #tag)' % tok)
            if not NAME_FULL.match(name):
                _err(game, "error", n, 'passage name "%s" may only use letters, digits, _ and -' % name)
            if name.lower() == "end":
                _err(game, "error", n, '"END" is reserved and cannot be a passage name')
            if name.lower() in game.passages:
                _err(game, "error", n, 'duplicate passage "%s"' % name)
            cur = Passage(name, n, tags)
            game.passages[cur.key] = cur
            game.order.append(cur)
            continue

        if cur is None:
            _err(game, "error", n, "content outside of any passage")
            continue
        cur.lines.append(Item(text=trimmed, raw=raw, n=n, literal=literal))

    if fence is not None:
        _err(game, "error", fence["n"], "unclosed ``` block")
    game.lists.setdefault("inventory", [])
    return game


# ---------------------------------------------------------------- expressions
class Ctx(object):
    def __init__(self, vars=None, lists=None, visited=None, visits=None, current_passage=None,
                 extras=None, rng=None):
        self.vars = {} if vars is None else vars
        self.lists = {} if lists is None else lists
        self.visited = set() if visited is None else visited
        self.visits = {} if visits is None else visits
        self.current_passage = current_passage
        self.extras = {} if extras is None else extras
        self.rng = rng or _random.random


TOKEN_RE = re.compile(
    r"\"[^\"]*\"|'[^']*'|[0-9]+(?:\.[0-9]+)?|" + ID + r"|==|!=|<=|>=|&&|\|\||[!()<>+\-*/%,]")


def _tokens(src):
    return [m.group(0) for m in TOKEN_RE.finditer(src)]


def _quoted(k):
    return k is not None and k[:1] in ("'", '"')


def eval_expr(src, ctx=None):
    """One grammar for conditions, effects and inline text.

    or < and < not < comparisons < + - < * / %;  has ITEM, has no ITEM, LIST has ITEM,
    visited PASSAGE, count LIST, inventory, visits, random(lo, hi).
    """
    ctx = ctx or Ctx()
    t = _tokens(str(src))
    n = len(t)
    pos = [0]

    def peek():
        return t[pos[0]] if pos[0] < n else None

    def is_word(k):
        return k is not None and (WORD_RE.match(k) is not None or _quoted(k)) and k not in ("and", "or")

    def item_name():
        w = []
        while pos[0] < n and is_word(t[pos[0]]):
            k = t[pos[0]]
            pos[0] += 1
            w.append(k[1:-1] if _quoted(k) else k)
        return " ".join(w)

    def has_tail(lst):
        neg = False
        if peek() == "no":
            neg = True
            pos[0] += 1
        item = item_name()
        if not item:
            raise TgameError('"has" needs an item name')
        present = list_has(lst, item)
        return (not present) if neg else present

    def primary():
        tok = peek()
        if tok is None:
            raise TgameError("unexpected end of expression")
        if tok == "(":
            pos[0] += 1
            v = or_()
            if peek() != ")":
                raise TgameError("missing )")
            pos[0] += 1
            return v
        if tok == "-":
            pos[0] += 1
            return -to_num(primary())
        if tok == "has":
            pos[0] += 1
            return has_tail(ctx.lists.get("inventory"))
        if tok == "visited":
            pos[0] += 1
            name = peek()
            if name is None:
                raise TgameError('"visited" needs a passage name')
            pos[0] += 1
            while peek() == "-" and pos[0] + 1 < n and WORD_RE.match(t[pos[0] + 1]):
                name += "-" + t[pos[0] + 1]
                pos[0] += 2
            return name.lower() in ctx.visited
        if tok == "random":
            pos[0] += 1
            if peek() != "(":
                raise TgameError("random needs (lo, hi)")
            pos[0] += 1
            lo = to_num(or_())
            if peek() != ",":
                raise TgameError("random needs (lo, hi)")
            pos[0] += 1
            hi = to_num(or_())
            if peek() != ")":
                raise TgameError("missing ) after random")
            pos[0] += 1
            return float(int((ctx.rng() * (hi - lo + 1)) // 1)) + lo
        if tok == "count":
            pos[0] += 1
            name = peek()
            pos[0] += 1
            lst = ctx.lists.get(name)
            return float(len(lst)) if lst is not None else 0.0
        if tok[0] in "0123456789":
            pos[0] += 1
            return float(tok)
        if _quoted(tok):
            pos[0] += 1
            return tok[1:-1]
        if tok == "true":
            pos[0] += 1
            return True
        if tok == "false":
            pos[0] += 1
            return False
        if tok == "inventory":
            pos[0] += 1
            return float(len(ctx.lists.get("inventory") or []))
        if not WORD_RE.match(tok):
            raise TgameError('unexpected "%s"' % tok)
        pos[0] += 1
        if peek() == "has" and tok in ctx.lists:
            pos[0] += 1
            return has_tail(ctx.lists[tok])
        if tok in ctx.extras:
            return ctx.extras[tok]
        return ctx.vars[tok] if tok in ctx.vars else 0.0

    def mul():
        l = primary()
        while True:
            o = peek()
            if o in ("*", "/", "%"):
                pos[0] += 1
                r = primary()
                a, b = to_num(l), to_num(r)
                l = a * b if o == "*" else js_div(a, b) if o == "/" else js_mod(a, b)
            else:
                return l

    def add():
        l = mul()
        while True:
            o = peek()
            if o in ("+", "-"):
                pos[0] += 1
                r = mul()
                l = js_add(l, r) if o == "+" else to_num(l) - to_num(r)
            else:
                return l

    def cmp_():
        l = add()
        o = peek()
        if o in ("==", "!=", "<", "<=", ">", ">="):
            pos[0] += 1
            r = add()
            if o == "==":
                return loose_eq(l, r)
            if o == "!=":
                return not loose_eq(l, r)
            return compare(o, l, r)
        return l

    def not_():
        if peek() in ("not", "!"):
            pos[0] += 1
            return not truthy(not_())
        return cmp_()

    def and_():
        l = not_()
        while peek() in ("and", "&&"):
            pos[0] += 1
            r = not_()
            l = r if truthy(l) else l
        return l

    def or_():
        l = and_()
        while peek() in ("or", "||"):
            pos[0] += 1
            r = and_()
            l = l if truthy(l) else r
        return l

    v = or_()
    if pos[0] < n:
        raise TgameError('unexpected "%s"' % t[pos[0]])
    return v


def eval_condition(src, ctx):
    s = str(src).strip()
    if not s:
        return True
    return truthy(eval_expr(s, ctx))


# ---------------------------------------------------------------- inline text
def match_brace(s, i):
    d = 0
    for k in range(i, len(s)):
        if s[k] == "{":
            d += 1
        elif s[k] == "}":
            d -= 1
            if d == 0:
                return k
    return -1


_IF_RE = re.compile(r"^if\s")


def find_if_block(s, start):
    d, else_at, else_end, i = 0, -1, -1, start
    while i < len(s):
        if s[i] == "{":
            c = match_brace(s, i)
            if c < 0:
                return None
            inner = s[i + 1:c].strip()
            if _IF_RE.match(inner):
                d += 1
            elif inner == "end":
                if d == 0:
                    return (else_at, else_end, i, c + 1)
                d -= 1
            elif inner == "else" and d == 0 and else_at < 0:
                else_at, else_end = i, c + 1
            i = c + 1
            continue
        i += 1
    return None


def interp(s, ctx):
    return render_inline(str(s), ctx, 0)


def render_inline(s, ctx, depth):
    if depth > 40:
        return s
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c != "{":
            out.append(c)
            i += 1
            continue
        close = match_brace(s, i)
        if close < 0:
            out.append(s[i:])
            break
        inner = s[i + 1:close].strip()
        if _IF_RE.match(inner):
            blk = find_if_block(s, close + 1)
            if blk is None:
                i = close + 1
                continue
            else_at, else_end, end_at, end_end = blk
            try:
                on = eval_condition(inner[2:].strip(), ctx)
            except TgameError:
                on = False
            yes = s[close + 1:(else_at if else_at >= 0 else end_at)]
            no = s[else_end:end_at] if else_at >= 0 else ""
            out.append(render_inline(yes if on else no, ctx, depth + 1))
            i = end_end
            continue
        out.append(expand_interp(inner, ctx, depth))
        i = close + 1
    return "".join(out)


def expand_interp(inner, ctx, depth):
    if not inner:
        return ""
    m = re.match(r"^count\s+(\S+)$", inner)
    if m:
        lst = ctx.lists.get(m.group(1))
        return str(len(lst)) if lst is not None else "0"
    if inner == "inventory":
        return ", ".join(ctx.lists.get("inventory") or [])
    if inner == "visits":
        return str(ctx.visits.get(ctx.current_passage, 0))
    parts = split_top_level(inner, ["|"])
    if len(parts) in (2, 3):
        try:
            cond = eval_condition(parts[0].strip(), ctx)
        except TgameError:
            cond = False
        yes = parts[1].strip()
        no = parts[2].strip() if len(parts) == 3 else ""
        return render_inline(yes if cond else no, ctx, depth + 1)
    if ID_FULL.match(inner):
        if inner in ctx.extras:
            return js_str(ctx.extras[inner])
        if inner in ctx.lists:
            return ", ".join(ctx.lists[inner])
        v = ctx.vars.get(inner)
        return js_str(v) if v is not None else ""
    try:
        return js_str(eval_expr(inner, ctx))
    except TgameError:
        return ""


# ---------------------------------------------------------------- effects
RX_LIST_OP = re.compile(r"^(" + ID + r")\s+(add|remove)\s+(.+?)$")
RX_LIST_CLR = re.compile(r"^(" + ID + r")\s+clear$")
RX_ASSIGN = re.compile(r"^(" + ID + r")\s*(\+=|-=|\*=|/=|%=|=)\s*([\s\S]*)$")
RX_INCDEC = re.compile(r"^(" + ID + r")\s*(\+\+|--)$")


def apply_effects(src, ctx):
    vars_, lists = ctx.vars, ctx.lists
    for raw in split_top_level(str(src), [",", ";"], True):
        e = raw.strip()
        if not e:
            continue
        m = re.match(r"^get\s+(.+?)$", e)
        if m:
            item = m.group(1).strip()
            inv = lists.setdefault("inventory", [])
            if item and not list_has(inv, item):
                inv.append(item)
            continue
        m = re.match(r"^drop\s+(.+?)$", e)
        if m:
            inv = lists.get("inventory") or []
            idx = list_index(inv, m.group(1).strip())
            if idx >= 0:
                del inv[idx]
            continue
        if e == "clear inventory":
            if "inventory" in lists:
                del lists["inventory"][:]
            continue
        m = RX_LIST_OP.match(e)
        if m:
            name, op, item = m.group(1), m.group(2), m.group(3).strip()
            if name not in lists:
                raise TgameError('unknown list "%s"' % name)
            if op == "add":
                if item and not list_has(lists[name], item):
                    lists[name].append(item)
            else:
                idx = list_index(lists[name], item)
                if idx >= 0:
                    del lists[name][idx]
            continue
        m = RX_LIST_CLR.match(e)
        if m:
            if m.group(1) not in lists:
                raise TgameError('unknown list "%s"' % m.group(1))
            del lists[m.group(1)][:]
            continue
        m = RX_INCDEC.match(e)
        if m:
            vars_[m.group(1)] = num_or0(vars_.get(m.group(1), math.nan)) + (1 if m.group(2) == "++" else -1)
            continue
        m = RX_ASSIGN.match(e)
        if m:
            name, op = m.group(1), m.group(2)
            val = eval_expr(m.group(3), ctx)
            cur = vars_.get(name)
            if op == "=":
                vars_[name] = val
            elif op == "+=" and (isinstance(cur, str) or isinstance(val, str)):
                vars_[name] = ("" if cur is None else js_str(cur)) + js_str(val)
            else:
                a = num_or0(cur if cur is not None else math.nan)
                b = num_or0(val)
                vars_[name] = (a + b if op == "+=" else a - b if op == "-=" else a * b if op == "*="
                               else js_div(a, b) if op == "/=" else js_mod(a, b))
            continue
        raise TgameError('unrecognized effect "%s"' % e)


# ---------------------------------------------------------------- choices
def split_choice(line):
    s = line[1:].strip()
    label, target, effects = s, None, ""
    arrow = s.find("->")
    if arrow >= 0:
        label = s[:arrow].strip()
        rest = s[arrow + 2:].strip()
        ob = rest.find("[")
        if ob >= 0 and rest.endswith("]"):
            target = rest[:ob].strip()
            effects = rest[ob + 1:-1].strip()
        else:
            target = rest
    else:
        ob = s.find("[")
        if ob >= 0 and s.endswith("]"):
            label = s[:ob].strip()
            effects = s[ob + 1:-1].strip()
    return label, target, effects


class Choice(object):
    """One option offered to the player."""
    def __init__(self, label, aliases, target, effects, once, n=0):
        self.label, self.aliases, self.target = label, aliases, target
        self.effects, self.once, self.n = effects, once, n

    def __repr__(self):
        return "Choice(%r)" % self.label


def parse_choice(line, ctx):
    label_src, target, effects_src = split_choice(line)
    label_parts = split_top_level(label_src, ["|"])
    label = label_parts[0].strip()
    if not label:
        return None

    def render(x):
        return unescape_text(interp(x, ctx))

    once, keep = False, []
    for part in split_top_level(effects_src, [",", ";"], True):
        p = part.strip()
        if p == "once":
            once = True
        elif p:
            keep.append(p)
    aliases = [a for a in (render(a.strip()) for a in label_parts[1:]) if a]
    return Choice(render(label), aliases, target, ", ".join(keep), once)


def norm_phrase(s, ignore):
    ig = set(ignore or [])
    cleaned = re.sub(r"[^\w\s]|_", " ", str(s).lower())
    return " ".join(w for w in cleaned.split() if w and w not in ig)


def _is_subseq(a, b):
    if not a:
        return False
    j = 0
    for w in b:
        if w == a[j]:
            j += 1
        if j == len(a):
            return True
    return False


def match_choice(text, choices, ignore=None):
    """Typed input -> choice. Returns ('index', i), ('ambiguous', [i, ...]) or ('none', None).

    Tries a number, then an exact label or alias, then the words of a label in order.
    More than one fit is reported as ambiguous instead of silently picking one.
    """
    raw = str(text).strip()
    if re.match(r"^[0-9]+$", raw):
        i = int(raw) - 1
        return ("index", i) if 0 <= i < len(choices) else ("none", None)
    q = norm_phrase(raw, ignore)
    if not q:
        return ("none", None)
    forms = []
    for c in choices:
        fs = [norm_phrase(f, ignore) for f in [c.label] + list(c.aliases or [])]
        forms.append([f for f in fs if f])
    exact = [i for i, fs in enumerate(forms) if q in fs]
    if len(exact) == 1:
        return ("index", exact[0])
    if len(exact) > 1:
        return ("ambiguous", exact)
    qw = q.split(" ")
    part = [i for i, fs in enumerate(forms) if any(_is_subseq(qw, f.split(" ")) for f in fs)]
    if len(part) == 1:
        return ("index", part[0])
    if len(part) > 1:
        return ("ambiguous", part)
    return ("none", None)


# ---------------------------------------------------------------- interpreter
class Interp(object):
    """Runs a parsed game.

    Deterministic: the same source, seed and sequence of answers always gives the
    same run.  That is what makes undo / save / restore possible — a save is
    {seed, history} and loading replays it.
    """

    def __init__(self, game, skip_effects=False, seed=None):
        self.game = game
        self.skip_effects = bool(skip_effects)
        if seed is not None:
            self.seed = to_int32(seed)
        elif game.seed is not None:
            self.seed = to_int32(game.seed)
        else:
            self.seed = to_int32(_random.getrandbits(31) ^ int(time.time() * 1000))
        self.rng = mulberry32(self.seed)
        self.vars = {}
        self.lists = dict((k, list(v)) for k, v in game.lists.items())
        self.visited = set()
        self.visits = {}
        self.used = set()               # once-only choices and [once ...] lines already spent
        self.passage = None
        self.steps = 0
        self._last = None
        self.typewriter = bool(game.typewriter_enabled)
        self.typewriter_speed = game.typewriter_speed or 30
        ctx = self.ctx()
        for name, src, _n in game.inits:
            try:
                self.vars[name] = eval_expr(src, ctx)
            except TgameError:
                self.vars[name] = 0.0

    def ctx(self):
        return Ctx(vars=self.vars, lists=self.lists, visited=self.visited, visits=self.visits,
                   current_passage=self.passage,
                   extras={"visits": float(self.visits.get(self.passage, 0))}, rng=self.rng)

    def _mk_text(self, raw, style=None):
        return Event("text", text=unescape_text(raw), html=fmt_html(raw), raw=raw, style=style,
                     typewriter=(not style) and self.typewriter and not self.skip_effects,
                     speed=self.typewriter_speed)

    def run_lines(self, pass_, ctx, snippet, depth, entering):
        """Runs one passage (or >> snippet). Returns (jump, choices, stop)."""
        g = self.game
        legacy = g.format == 2           # format 2: every line is its own paragraph
        choices, stack = [], []
        jump = None
        st = {"buf": "", "have": False, "hard": False}

        def live():
            if not stack:
                return True
            top = stack[-1]
            return top["parent"] and top["taken"]

        def flush():
            if not st["have"]:
                return
            raw = st["buf"]
            st["buf"], st["have"], st["hard"] = "", False, False
            yield self._mk_text(raw)

        def add_text(raw):
            if legacy:
                yield self._mk_text(raw)
                return
            hb = False
            if raw[-1:] == "\\":
                raw, hb = raw[:-1].rstrip(), True
            if st["have"]:
                st["buf"] += ("\n" if st["hard"] else " ") + raw
            else:
                st["buf"], st["have"] = raw, True
            st["hard"] = hb
            return
            yield  # pragma: no cover  (makes this a generator in every branch)

        for item in pass_.lines:
            k = classify_line(item)
            t = item.text
            try:
                if k.kind == "if":
                    yield from flush()
                    is_live = live()
                    cond = is_live and eval_condition(k.cond, ctx)
                    stack.append({"parent": is_live, "taken": bool(cond)})
                    continue
                if k.kind == "else":
                    if not stack:
                        raise TgameError("else without if")
                    yield from flush()
                    top = stack[-1]
                    if top["parent"]:
                        top["taken"] = not top["taken"]
                    continue
                if k.kind == "end":
                    if not stack:
                        raise TgameError("end without if")
                    yield from flush()
                    stack.pop()
                    continue
                if not live():
                    continue

                kind = k.kind
                if kind == "blank":
                    yield from flush()
                elif kind == "verbatim":
                    yield from flush()
                    yield Event("text", text=item.verbatim, html=esc_html(item.verbatim), raw=item.verbatim,
                                style="pre", typewriter=False, speed=self.typewriter_speed)
                elif kind in ("text", "badmode"):
                    yield from add_text(interp(t, ctx))
                elif kind == "pause":
                    yield from flush()
                    if not self.skip_effects and k.ms > 0:
                        yield Event("pause", ms=k.ms)
                elif kind == "mode":
                    yield from flush()
                    if k.mode == "type":
                        self.typewriter = True
                    elif k.mode == "normal":
                        self.typewriter = False
                    elif k.mode == "fast":
                        self.typewriter, self.typewriter_speed = True, 15
                    elif k.mode == "slow":
                        self.typewriter, self.typewriter_speed = True, 60
                elif kind == "input":
                    yield from flush()
                    spec = parse_prompt_line(t)
                    if spec is None:
                        raise TgameError("malformed ? directive")
                    if spec.prompt:
                        yield self._mk_text(interp(spec.prompt, ctx), "prompt")
                    while True:
                        answer = yield Event("input", var_name=spec.var_name, prompt=spec.prompt, vtype=spec.vtype)
                        s = ("" if answer is None else str(answer)).strip()
                        if spec.vtype == "number" and not re.match(r"^-?[0-9]+(\.[0-9]+)?$", s):
                            yield Event("text", text="Please enter a number.", html="Please enter a number.",
                                        raw="Please enter a number.", style="sys")
                            continue
                        break
                    if spec.var_name:
                        numeric = s != "" and re.match(r"^-?[0-9]+(\.[0-9]+)?$", s) is not None
                        if spec.vtype == "text":
                            self.vars[spec.var_name] = s
                        elif spec.vtype == "number":
                            self.vars[spec.var_name] = float(s)
                        else:
                            self.vars[spec.var_name] = float(s) if numeric else s
                    if spec.target:
                        if snippet:
                            raise TgameError("-> is not allowed in a >> snippet")
                        jump = spec.target
                        break
                elif kind == "choice":
                    yield from flush()
                    if snippet:
                        raise TgameError("choices are not allowed in a >> snippet")
                    c = parse_choice(t, ctx)
                    if c is None:
                        raise TgameError("malformed choice")
                    c.n = item.n
                    if c.once and ("c%d" % item.n) in self.used:
                        continue                          # already taken: hidden
                    choices.append(c)
                elif kind == "jump":
                    yield from flush()
                    if snippet:
                        raise TgameError("-> is not allowed in a >> snippet")
                    jump = k.target
                    break
                elif kind == "call":
                    yield from flush()
                    sub = g.passages.get(k.target.lower())
                    if sub is None:
                        raise TgameError('>> missing passage "%s"' % k.target)
                    if depth >= 32:
                        raise TgameError(">> nested too deeply")
                    r = yield from self.run_lines(sub, ctx, True, depth + 1, entering)
                    if r[2]:
                        return r
                elif kind == "effect":
                    src = k.src
                    m = re.match(r"^(once|enter)\s+([\s\S]+)$", src.strip())
                    if m:
                        if m.group(1) == "once":
                            key = "e%d" % item.n
                            if key in self.used:
                                continue
                            self.used.add(key)
                        elif not entering:
                            continue                      # [enter ...] only on arrival
                        src = m.group(2)
                    apply_effects(src, ctx)
            except TgameError as e:
                yield Event("error", text="line %d: %s" % (item.n, e))
                return (None, [], True)
        yield from flush()
        return (jump, choices, False)

    def run(self):
        """The event generator. Start with next(); answer `input`/`choice` events with .send()."""
        g = self.game
        start = g.meta.get("start") or (g.order[0].key if g.order else "")
        cur = start.lower()
        if not cur:
            yield Event("error", text="no passages defined")
            return
        while True:
            self.steps += 1
            if self.steps > 500000:
                yield Event("error", text="step limit exceeded")
                return
            pass_ = g.passages.get(cur)
            if pass_ is None:
                yield Event("error", text='missing passage: "%s"' % cur)
                return
            self.passage = cur
            entering = cur != self._last
            if entering:
                self.visited.add(cur)
                self.visits[cur] = self.visits.get(cur, 0) + 1
            self._last = cur

            ctx = self.ctx()
            jump, choices, stop = yield from self.run_lines(pass_, ctx, False, 0, entering)
            if stop:
                return
            if jump is not None:
                if jump.upper() == "END":
                    yield Event("end")
                    return
                cur = jump.lower()
                continue
            if not choices:
                yield Event("end")
                return

            i = yield Event("choice", choices=choices, passage=cur, parser_mode=g.parser_mode)
            if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(choices):
                yield Event("error", text="invalid choice")
                return
            c = choices[i]
            if c.once:
                self.used.add("c%d" % c.n)
            if c.effects:
                try:
                    apply_effects(c.effects, self.ctx())
                except TgameError as e:
                    yield Event("error", text="line %d: %s" % (c.n, e))
                    return
            if c.target:
                if c.target.upper() == "END":
                    yield Event("end")
                    return
                cur = c.target.lower()
