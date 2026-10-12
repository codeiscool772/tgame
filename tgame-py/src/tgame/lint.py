"""Linter: finds the problems the reference IDE reports (a port of its lint())."""
import re

from .core import (TGAME_FORMAT, Problem, Ctx, TgameError, TOKEN_RE, WORD_RE, ID_FULL,
                   RX_LIST_OP, RX_LIST_CLR, RX_ASSIGN, RX_INCDEC,
                   classify_line, split_choice, split_top_level, parse_prompt_line, eval_expr)

LINT_KW = frozenset(["and", "or", "not", "has", "no", "visited", "visits", "inventory",
                     "random", "count", "true", "false"])
_ID_START = re.compile(r"^[^\W\d]")


def expr_info(src):
    """Identifiers an expression needs declared, plus passages named by `visited`."""
    ids, visited = [], []
    toks = [m.group(0) for m in TOKEN_RE.finditer(str(src))]
    i = 0
    while i < len(toks):
        t = toks[i]
        if t[:1] in ("'", '"') or t[:1].isdigit():
            i += 1
            continue
        if t == "has":
            i += 1
            if i < len(toks) and toks[i] == "no":
                i += 1
            while (i < len(toks) and (WORD_RE.match(toks[i]) or toks[i][:1] in ("'", '"'))
                   and toks[i] not in ("and", "or")):
                i += 1
            continue
        if t == "visited":
            i += 1
            name = toks[i] if i < len(toks) else ""
            while i + 2 < len(toks) and toks[i + 1] == "-" and WORD_RE.match(toks[i + 2]):
                name += "-" + toks[i + 2]
                i += 2
            if name:
                visited.append(name.lower())
            i += 1
            continue
        if t == "count":
            i += 2
            continue
        if t not in LINT_KW and _ID_START.match(t):
            ids.append(t)
        i += 1
    return ids, visited


def inline_groups(text):
    """Every {...} group, innermost first."""
    out = []
    s = str(text)
    while True:
        prev = s

        def grab(m):
            out.append(m.group(1).strip())
            return "\x01"
        s = re.sub(r"\{([^{}]*)\}", grab, s)
        if s == prev:
            break
    return out


def lint(game):
    out = list(game.errors)

    def push(sev, n, msg):
        out.append(Problem(sev, n, msg))

    start_key = (game.meta.get("start") or "").lower()
    if game.format is None:
        push("warn", 1, 'no @format directive — assuming format %d (add "@format %d")' % (TGAME_FORMAT, TGAME_FORMAT))
    if not start_key:
        push("warn", 1, "no @start directive — using the first passage")
    elif start_key not in game.passages:
        push("error", 1, '@start passage "%s" doesn\'t exist' % game.meta.get("start"))

    declared = set(game.vars)
    list_names = set(game.lists)
    used = {}                       # name -> first line used
    visited_refs = []
    edges = {}
    calls = set()

    def lint_ctx():
        return Ctx(vars={}, lists=dict((k, []) for k in list_names), extras={"visits": 0}, rng=lambda: 0.5)

    def note(ids, vis, n):
        for ident in ids:
            used.setdefault(ident, n)
        for v in vis:
            visited_refs.append((v, n))

    def check_expr(src, n, what):
        try:
            eval_expr(src, lint_ctx())
        except TgameError as e:
            push("error", n, 'bad %s "%s": %s' % (what, str(src).strip(), e))
            return
        note(*(expr_info(src) + (n,)))

    def check_effects(src, n, is_choice):
        for raw in split_top_level(str(src), [",", ";"], True):
            e = raw.strip()
            if not e:
                continue
            if is_choice and e == "once":
                continue
            if not is_choice:
                e = re.sub(r"^(once|enter)\s+", "", e)
            if re.match(r"^get\s+\S", e) or re.match(r"^drop\s+\S", e) or e == "clear inventory":
                continue
            m = RX_LIST_OP.match(e) or RX_LIST_CLR.match(e)
            if m:
                if m.group(1) not in list_names:
                    push("error", n, 'unknown list "%s" (declare it with @list %s)' % (m.group(1), m.group(1)))
                continue
            m = RX_INCDEC.match(e)
            if m:
                used.setdefault(m.group(1), n)
                continue
            m = RX_ASSIGN.match(e)
            if m:
                used.setdefault(m.group(1), n)
                check_expr(m.group(3), n, "expression")
                continue
            push("error", n, 'unrecognized effect "%s"' % e)

    balance = {"depth": 0, "n": 0}

    def check_inline(text, n):
        for g in inline_groups(text):
            if re.match(r"^if\s", g):
                balance["depth"] += 1
                balance["n"] = n
                check_expr(g[2:], n, "condition")
            elif g == "end":
                balance["depth"] -= 1
            elif g in ("else", "inventory", "visits") or re.match(r"^count\s", g):
                pass
            else:
                parts = split_top_level(g, ["|"])
                if len(parts) in (2, 3):
                    check_expr(parts[0], n, "condition")
                elif len(parts) == 1:
                    try:
                        eval_expr(g, lint_ctx())
                        note(*(expr_info(g) + (n,)))
                    except TgameError as e:
                        push("warn", n, 'bad {…} expression "{%s}": %s' % (g, e))

    for p in game.order:
        stack = []
        from_p = set()
        balance["depth"] = 0
        for item in p.lines:
            k = classify_line(item)
            t = item.text
            kind = k.kind
            if kind in ("blank", "verbatim", "pause", "mode"):
                continue
            if kind == "if":
                stack.append(True)
                check_expr(k.cond, item.n, "condition")
            elif kind == "else":
                if not stack:
                    push("error", item.n, "else without a matching if")
            elif kind == "end":
                if not stack:
                    push("error", item.n, "end without a matching if")
                else:
                    stack.pop()
            elif kind == "badmode":
                push("warn", item.n, 'unknown mode "%s" — use ~type, ~normal, ~fast or ~slow (escape with \\~ to print it)' % t)
            elif kind == "input":
                spec = parse_prompt_line(t)
                if spec is None:
                    push("error", item.n, "malformed ? directive")
                    continue
                if spec.var_name:
                    declared.add(spec.var_name)
                if spec.target and spec.target.upper() != "END":
                    from_p.add(spec.target.lower())
                if spec.prompt:
                    check_inline(spec.prompt, item.n)
            elif kind == "jump":
                if k.target and k.target.upper() != "END":
                    from_p.add(k.target.lower())
                elif not k.target:
                    push("error", item.n, "-> needs a target")
            elif kind == "call":
                if not k.target:
                    push("error", item.n, ">> needs a passage name")
                    continue
                calls.add(k.target.lower())
                from_p.add(k.target.lower())
            elif kind == "choice":
                label, target, effects = split_choice(t)
                label_parts = split_top_level(label, ["|"])
                if not label_parts[0].strip():
                    push("error", item.n, "choice has no label")
                for lp in label_parts:
                    check_inline(lp, item.n)
                if target is not None:
                    if not target:
                        push("error", item.n, "choice has an empty target")
                    elif target.upper() != "END":
                        from_p.add(target.lower())
                if effects:
                    check_effects(effects, item.n, True)
            elif kind == "effect":
                check_effects(k.src, item.n, False)
            else:
                check_inline(t, item.n)

        if stack:
            push("error", p.n, 'passage "%s" has %d unclosed if block(s)' % (p.name, len(stack)))
        if balance["depth"] != 0:
            push("warn", balance["n"] or p.n, 'passage "%s" has an unbalanced {if …}…{end} in its text' % p.name)
        edges[p.key] = from_p

    for frm, targets in edges.items():
        for t in targets:
            if t not in game.passages:
                ps = game.passages[frm]
                push("error", ps.n, '"%s" links to missing passage "%s"' % (ps.name, t))
    for name, n in visited_refs:
        if name not in game.passages:
            push("warn", n, '"visited %s" refers to a passage that doesn\'t exist' % name)

    for key in calls:
        sp = game.passages.get(key)
        if sp is None:
            continue
        for item in sp.lines:
            k = classify_line(item)
            if k.kind in ("choice", "jump"):
                push("error", item.n, 'passage "%s" is called with >> so it can\'t contain choices or ->' % sp.name)
                break
            if k.kind == "input":
                spec = parse_prompt_line(item.text)
                if spec is not None and spec.target:
                    push("error", item.n, 'passage "%s" is called with >> so its ? line can\'t jump' % sp.name)
                    break

    root = start_key or (game.order[0].key if game.order else None)
    if root:
        seen, stk = set(), [root]
        while stk:
            key = stk.pop()
            if key in seen or key not in game.passages:
                continue
            seen.add(key)
            stk.extend(edges.get(key, ()))
        for p in game.order:
            if p.key not in seen:
                push("warn", p.n, 'passage "%s" is unreachable from @start' % p.name)

    lower_declared = dict((d.lower(), d) for d in declared)
    for name, n in used.items():
        if name in declared or name in list_names:
            continue
        hint = lower_declared.get(name.lower())
        push("warn", n, 'variable "%s" is used but never declared with @set' % name +
             (' — did you mean "%s"? (variable names are case-sensitive)' % hint if hint else ""))

    out.sort(key=lambda p: (p.n, 0 if p.sev == "error" else 1))
    return out
