/* ═══════════════════════════════════════════════════════════════════
   LINTER
   ═══════════════════════════════════════════════════════════════════ */
const LINT_KW = new Set(['and','or','not','has','no','visited','visits','inventory','random','count','true','false']);

/* identifiers an expression needs to be declared variables/lists, plus passages named by `visited` */
function exprInfo(src){
  const ids = [], visited = [];
  const toks = String(src).match(TOKEN_RE) || [];
  for (let i = 0; i < toks.length; i++){
    const t = toks[i];
    if (/^["']/.test(t) || /^\d/.test(t)) continue;
    if (t === 'has'){
      i++;
      if (toks[i] === 'no') i++;
      while (i < toks.length && (WORD_RE.test(toks[i]) || /^["']/.test(toks[i])) && toks[i] !== 'and' && toks[i] !== 'or') i++;
      i--;
      continue;
    }
    if (t === 'visited'){
      i++;
      let name = toks[i] || '';
      while (toks[i + 1] === '-' && toks[i + 2] !== undefined && WORD_RE.test(toks[i + 2])){ name += '-' + toks[i + 2]; i += 2; }
      if (name) visited.push(name.toLowerCase());
      continue;
    }
    if (t === 'count'){ i++; continue; }
    if (LINT_KW.has(t)) continue;
    if (/^[\p{L}_]/u.test(t)) ids.push(t);
  }
  return { ids: ids, visited: visited };
}

/* every {…} group, innermost first */
function inlineGroups(text){
  const out = [];
  let s = String(text), prev;
  do {
    prev = s;
    s = s.replace(/\{([^{}]*)\}/g, function(_, inner){ out.push(inner.trim()); return '\u0001'; });
  } while (s !== prev);
  return out;
}

function lint(game){
  const out = game.errors.slice();
  const push = function(sev, n, msg){ out.push({ sev: sev, n: n, msg: msg }); };
  const startKey = (game.meta.start || '').toLowerCase();

  if (game.format == null) push('warn', 1, 'no @format directive — assuming format ' + TGAME_FORMAT + ' (add "@format ' + TGAME_FORMAT + '")');
  if (!startKey) push('warn', 1, 'no @start directive — using the first passage');
  else if (!game.passages[startKey]) push('error', 1, '@start passage "' + game.meta.start + '" doesn\'t exist');

  const declared = new Set(Object.keys(game.vars));
  const listNames = new Set(Object.keys(game.lists));
  const used = new Map();                 /* name -> first line where used */
  const visitedRefs = [];                 /* {name, n} */
  const edges = new Map();
  const calls = new Set();

  const lintCtx = function(){
    const lists = {};
    listNames.forEach(function(k){ lists[k] = []; });
    return { vars: {}, lists: lists, visited: new Set(), extras: { visits: 0 }, rng: function(){ return 0.5; } };
  };
  const note = function(info, n){
    info.ids.forEach(function(id){ if (!used.has(id)) used.set(id, n); });
    info.visited.forEach(function(v){ visitedRefs.push({ name: v, n: n }); });
  };
  const checkExpr = function(src, n, what){
    try { evalExpr(src, lintCtx()); }
    catch(e){ push('error', n, 'bad ' + what + ' "' + String(src).trim() + '": ' + e.message); return; }
    note(exprInfo(src), n);
  };
  const checkEffects = function(src, n, isChoice){
    splitTopLevel(String(src), [',', ';'], true).forEach(function(raw){
      let e = raw.trim();
      if (!e) return;
      if (isChoice && e === 'once') return;
      if (!isChoice) e = e.replace(/^(once|enter)\s+/, '');
      let m;
      if (/^get\s+\S/.test(e) || /^drop\s+\S/.test(e) || e === 'clear inventory') return;
      if ((m = e.match(RX_LIST_OP)) || (m = e.match(RX_LIST_CLR))){
        if (!listNames.has(m[1])) push('error', n, 'unknown list "' + m[1] + '" (declare it with @list ' + m[1] + ')');
        return;
      }
      if ((m = e.match(RX_INCDEC))){ if (!used.has(m[1])) used.set(m[1], n); return; }
      if ((m = e.match(RX_ASSIGN))){
        if (!used.has(m[1])) used.set(m[1], n);
        checkExpr(m[3], n, 'expression');
        return;
      }
      push('error', n, 'unrecognized effect "' + e + '"');
    });
  };
  const inlineBalance = { depth: 0, n: 0 };
  const checkInline = function(text, n){
    inlineGroups(text).forEach(function(g){
      if (/^if\s/.test(g)){
        inlineBalance.depth++; inlineBalance.n = n;
        checkExpr(g.slice(3), n, 'condition');
      }
      else if (g === 'end'){ inlineBalance.depth--; }
      else if (g === 'else' || g === 'inventory' || g === 'visits' || /^count\s/.test(g)){ /* ok */ }
      else {
        const parts = splitTopLevel(g, ['|']);
        if (parts.length === 2 || parts.length === 3) checkExpr(parts[0], n, 'condition');
        else if (parts.length === 1) {
          try { evalExpr(g, lintCtx()); note(exprInfo(g), n); }
          catch(e){ push('warn', n, 'bad {…} expression "{' + g + '}": ' + e.message); }
        }
      }
    });
  };

  for (let pi = 0; pi < game.order.length; pi++){
    const p = game.order[pi];
    const stack = [];
    const fromP = new Set();
    inlineBalance.depth = 0;

    for (let li = 0; li < p.lines.length; li++){
      const item = p.lines[li];
      const k = classifyLine(item);
      const t = item.text;

      switch (k.kind){
        case 'blank': case 'verbatim': case 'pause': case 'mode': break;

        case 'if':
          stack.push(true);
          checkExpr(k.cond, item.n, 'condition');
          break;
        case 'else':
          if (!stack.length) push('error', item.n, 'else without a matching if');
          break;
        case 'end':
          if (!stack.length) push('error', item.n, 'end without a matching if');
          else stack.pop();
          break;

        case 'badmode':
          push('warn', item.n, 'unknown mode "' + t + '" — use ~type, ~normal, ~fast or ~slow (escape with \\~ to print it)');
          break;

        case 'input': {
          const spec = parsePromptLine(t);
          if (!spec){ push('error', item.n, 'malformed ? directive'); break; }
          if (spec.varName) declared.add(spec.varName);
          if (spec.target && spec.target.toUpperCase() !== 'END') fromP.add(spec.target.toLowerCase());
          if (spec.prompt) checkInline(spec.prompt, item.n);
          break;
        }

        case 'jump':
          if (k.target && k.target.toUpperCase() !== 'END') fromP.add(k.target.toLowerCase());
          else if (!k.target) push('error', item.n, '-> needs a target');
          break;

        case 'call':
          if (!k.target){ push('error', item.n, '>> needs a passage name'); break; }
          calls.add(k.target.toLowerCase());
          fromP.add(k.target.toLowerCase());
          break;

        case 'choice': {
          const sc = splitChoice(t);
          const labelParts = splitTopLevel(sc.label, ['|']);
          if (!labelParts[0].trim()) push('error', item.n, 'choice has no label');
          labelParts.forEach(function(lp){ checkInline(lp, item.n); });
          if (sc.target !== null){
            if (!sc.target) push('error', item.n, 'choice has an empty target');
            else if (sc.target.toUpperCase() !== 'END') fromP.add(sc.target.toLowerCase());
          }
          if (sc.effects) checkEffects(sc.effects, item.n, true);
          break;
        }

        case 'effect':
          checkEffects(k.src, item.n, false);
          break;

        default:   /* narration */
          checkInline(t, item.n);
      }
    }

    if (stack.length)
      push('error', p.n, 'passage "' + p.name + '" has ' + stack.length + ' unclosed if block(s)');
    if (inlineBalance.depth !== 0)
      push('warn', inlineBalance.n || p.n, 'passage "' + p.name + '" has an unbalanced {if …}…{end} in its text');
    edges.set(p.key, fromP);
  }

  /* missing targets */
  edges.forEach(function(targets, from){
    targets.forEach(function(t){
      if (!game.passages[t]){
        const pass = game.passages[from];
        push('error', pass.n, '"' + pass.name + '" links to missing passage "' + t + '"');
      }
    });
  });
  visitedRefs.forEach(function(r){
    if (!game.passages[r.name]) push('warn', r.n, '"visited ' + r.name + '" refers to a passage that doesn\'t exist');
  });

  /* >> snippet passages may not contain choices or jumps */
  calls.forEach(function(key){
    const sp = game.passages[key];
    if (!sp) return;
    for (let li = 0; li < sp.lines.length; li++){
      const k = classifyLine(sp.lines[li]);
      if (k.kind === 'choice' || k.kind === 'jump'){
        push('error', sp.lines[li].n, 'passage "' + sp.name + '" is called with >> so it can\'t contain choices or ->');
        break;
      }
      if (k.kind === 'input'){
        const spec = parsePromptLine(sp.lines[li].text);
        if (spec && spec.target){ push('error', sp.lines[li].n, 'passage "' + sp.name + '" is called with >> so its ? line can\'t jump'); break; }
      }
    }
  });

  /* reachability from @start */
  const root = startKey || (game.order[0] && game.order[0].key);
  if (root){
    const seen = new Set();
    const stk = [root];
    while (stk.length){
      const key = stk.pop();
      if (seen.has(key) || !game.passages[key]) continue;
      seen.add(key);
      (edges.get(key) || new Set()).forEach(function(t){ stk.push(t); });
    }
    game.order.forEach(function(p){
      if (!seen.has(p.key)) push('warn', p.n, 'passage "' + p.name + '" is unreachable from @start');
    });
  }

  /* undeclared variables (case-sensitive, with a did-you-mean) */
  const lowerDeclared = {};
  declared.forEach(function(d){ lowerDeclared[d.toLowerCase()] = d; });
  used.forEach(function(n, name){
    if (declared.has(name) || listNames.has(name)) return;
    const hint = lowerDeclared[name.toLowerCase()];
    push('warn', n, 'variable "' + name + '" is used but never declared with @set' +
         (hint ? ' — did you mean "' + hint + '"? (variable names are case-sensitive)' : ''));
  });

  out.sort(function(a, b){ return a.n - b.n || (a.sev === 'error' ? -1 : 1); });
  return out;
}

