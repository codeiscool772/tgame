"use strict";
/* ═══════════════════════════════════════════════════════════════════
   tgame runtime — format 3
   Self-contained: parser, expression evaluator, interpreter (a generator
   that yields typed events) and a reference DOM player.

   Event protocol (what Interp.run() yields):
     {type:'text',   text, html, style?, typewriter, speed}   style: 'prompt'|'sys'|'pre'
     {type:'pause',  ms}
     {type:'input',  varName, prompt, vtype}      -> resume with the typed string
     {type:'choice', choices[], passage, parserMode} -> resume with a choice index
     {type:'end'}
     {type:'error',  text}
   ═══════════════════════════════════════════════════════════════════ */

const TGAME_FORMAT = 3;

/* identifiers are Unicode: letters, digits, underscore */
const ID = '[\\p{L}_][\\p{L}\\p{N}_]*';
function rx(src, flags){ return new RegExp(src.split('<ID>').join(ID), (flags || '') + 'u'); }
const ID_FULL   = rx('^<ID>$');
const NAME_FULL = /^[\p{L}\p{N}_-]+$/u;
const WORD_RE   = /^[\p{L}\p{N}_]/u;

/* ───────────── escapes ─────────────
   A backslash consumes the next character. Special characters become
   private-use placeholders so the parser cannot see them as syntax. */
const ESC_SET = '\\*?:@[]{}|>-~./`#';
const ESC_TO_PH = {};
const PH_TO_ESC = {};
(function(){
  for (let i = 0; i < ESC_SET.length; i++){
    const ch = ESC_SET[i];
    const ph = String.fromCharCode(0xE000 + i);
    ESC_TO_PH[ch] = ph;
    PH_TO_ESC[ph] = ch;
  }
})();
function escapeLine(line){
  return String(line).replace(/\\([\s\S]?)/g, function(_, ch){
    if (ch === '' || ch === undefined) return '\\';      /* trailing backslash = hard line break */
    if (ESC_TO_PH[ch]) return ESC_TO_PH[ch];
    return ch;
  });
}
function unescapeText(text){
  return String(text).replace(/[\uE000-\uE0FF]/g, function(ch){ return PH_TO_ESC[ch] || ch; });
}
function isEscapedStart(trimmed){
  return trimmed.length > 0 && PH_TO_ESC[trimmed[0]] !== undefined;
}
function escHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
  });
}
/* operates on text that still holds placeholders, so \* never becomes italics */
function fmtHTML(s){
  let h = escHtml(s);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return unescapeText(h);
}

/* ───────────── small utilities ───────────── */
function mulberry32(a){
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;      /* always in [0, 1) */
  };
}
function hashStr(s){
  let h = 5381;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function splitTopLevel(s, seps, quotes){
  const parts = [];
  let cur = '', depth = 0, q = null, i = 0;
  outer: while (i < s.length){
    const c = s[i];
    if (c === '\\' && i + 1 < s.length){ cur += c + s[i + 1]; i += 2; continue; }
    if (quotes){
      if (q){ cur += c; if (c === q) q = null; i++; continue; }
      if ((c === '"' || c === "'") && (i === 0 || !/[\p{L}\p{N}_]/u.test(s[i - 1]))){ q = c; cur += c; i++; continue; }
    }
    if (c === '(' || c === '[' || c === '{'){ depth++; cur += c; i++; continue; }
    if (c === ')' || c === ']' || c === '}'){ depth--; cur += c; i++; continue; }
    if (depth === 0){
      for (let k = 0; k < seps.length; k++){
        if (s.startsWith(seps[k], i)){ parts.push(cur); cur = ''; i += seps[k].length; continue outer; }
      }
    }
    cur += c; i++;
  }
  parts.push(cur);
  return parts;
}
function listHas(list, name){
  const n = String(name).toLowerCase();
  return (list || []).some(function(x){ return String(x).toLowerCase() === n; });
}
function listIndex(list, name){
  const n = String(name).toLowerCase();
  for (let i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === n) return i;
  return -1;
}

/* ───────────── line-level parsers ───────────── */
const PROMPT_BARE_RE   = rx('^\\?\\s+(<ID>)(?::(text|number))?\\s*(?:->\\s*(\\S+))?\\s*$');
const PROMPT_INLINE_RE = rx('^\\?\\s+(.+?)(?:\\s*\\[(<ID>)(?::(text|number))?\\])?\\s*(?:->\\s*(\\S+))?\\s*$');
const PAUSE_RE         = /^\.\.\.\s*(\d+(?:\.\d+)?)?\s*(ms|s)?\s*$/;
const MODE_RE          = /^~(\w+)\s*$/;
const MODES = { type:1, normal:1, fast:1, slow:1 };

function parsePromptLine(text){
  let m = text.match(PROMPT_BARE_RE);
  if (m) return { prompt: null, varName: m[1], vtype: m[2] || null, target: m[3] || null };
  m = text.match(PROMPT_INLINE_RE);
  if (m){
    const prompt = m[1].trim();
    if (!prompt) return null;
    return { prompt: prompt, varName: m[2] || null, vtype: m[3] || null, target: m[4] || null };
  }
  return null;
}
function parsePauseLine(text){
  const m = text.match(PAUSE_RE);
  if (!m) return null;
  const n = m[1] ? parseFloat(m[1]) : 500;
  const ms = m[2] === 's' ? n * 1000 : n;
  return Math.max(0, Math.round(ms));
}
function parseModeLine(text){
  const m = text.match(MODE_RE);
  if (!m) return null;
  const mode = m[1].toLowerCase();
  return MODES[mode] ? mode : null;
}

/* one classifier shared by the interpreter, linter, map and sidebar */
function classifyLine(item){
  if (item.blank) return { kind:'blank' };
  if (item.verbatim !== undefined) return { kind:'verbatim' };
  if (item.literal) return { kind:'text' };
  const t = item.text;
  if (t.startsWith('if ') && t.endsWith(':')) return { kind:'if', cond: t.slice(3, -1).trim() };
  if (t === 'else:') return { kind:'else' };
  if (t === 'end') return { kind:'end' };
  const ms = parsePauseLine(t);
  if (ms !== null) return { kind:'pause', ms: ms };
  const mode = parseModeLine(t);
  if (mode) return { kind:'mode', mode: mode };
  if (/^~\w+\s*$/.test(t)) return { kind:'badmode' };
  if (t[0] === '?') return { kind:'input' };
  if (t[0] === '*') return { kind:'choice' };
  if (t.slice(0, 2) === '->') return { kind:'jump', target: t.slice(2).trim() };
  if (t.slice(0, 2) === '>>') return { kind:'call', target: t.slice(2).trim() };
  if (t[0] === '[' && t.endsWith(']')) return { kind:'effect', src: t.slice(1, -1) };
  return { kind:'text' };
}

/* ═══════════════════════════════════════════════════════════════════
   PARSER
   ═══════════════════════════════════════════════════════════════════ */
const KNOWN_DIRECTIVES = {
  title:1, author:1, start:1, set:1, var:1, list:1, seed:1, parser:1,
  format:1, typewriter:1, ignore:1
};

function parse(src){
  const game = {
    meta: {}, vars: {}, inits: [], lists: {}, seed: null, parserMode: false,
    typewriterEnabled: false, typewriterSpeed: 30, format: null,
    ignore: ['the', 'a', 'an'],
    passages: {}, order: [], errors: []
  };
  let cur = null;
  let fence = null;
  const lines = String(src).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++){
    const raw = lines[i];

    /* fenced verbatim block: everything between ``` lines is literal */
    if (fence){
      if (/^\s*```\s*$/.test(raw)){
        if (cur) cur.lines.push({ text:'', verbatim: fence.lines.join('\n'), raw:'', n: fence.n });
        fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    if (/^\s*```\s*$/.test(raw)){
      if (!cur) game.errors.push({ sev:'error', n:i+1, msg:'content outside of any passage' });
      fence = { n: i + 1, lines: [] };
      continue;
    }

    const rt = raw.replace(/^\s+/, '');
    const literal = rt[0] === '\\';                 /* a leading backslash makes the whole line narration */
    const esc = escapeLine(raw);
    const trimmed = esc.replace(/^\s+/, '');
    if (!trimmed){
      if (cur && game.format !== 2) cur.lines.push({ blank: true, n: i + 1 });
      continue;
    }
    if (!literal && trimmed.slice(0, 2) === '//') continue;

    /* ---- directives ---- */
    if (!literal && trimmed[0] === '@'){
      const m = trimmed.match(/^@(\w+)\s*([\s\S]*)$/);
      if (!m){ game.errors.push({ sev:'error', n:i+1, msg:'malformed directive' }); continue; }
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (!KNOWN_DIRECTIVES[key])
        game.errors.push({ sev:'warn', n:i+1, msg:'unknown directive @' + m[1] });
      else if (cur)
        game.errors.push({ sev:'warn', n:i+1, msg:'@' + key + ' inside a passage is still global — it applies from the start of the game. Move it above the first passage.' });

      if (key === 'set' || key === 'var'){
        const eq = val.indexOf('=');
        if (eq < 0){ game.errors.push({ sev:'error', n:i+1, msg:'@set needs "name = value"' }); continue; }
        const name = val.slice(0, eq).trim();
        if (!ID_FULL.test(name)){
          game.errors.push({ sev:'error', n:i+1, msg:'@set: bad name "' + name + '"' }); continue;
        }
        const exprSrc = val.slice(eq + 1);
        try {
          game.vars[name] = evalExpr(exprSrc, { vars: Object.assign({}, game.vars), lists: {}, rng: function(){ return 0.5; } });
          game.inits.push({ name: name, src: exprSrc, n: i + 1 });
        } catch(e){ game.errors.push({ sev:'error', n:i+1, msg:'@set: ' + e.message }); }
      }
      else if (key === 'list'){
        if (!ID_FULL.test(val)){
          game.errors.push({ sev:'error', n:i+1, msg:'@list: bad name "' + val + '"' }); continue;
        }
        if (!(val in game.lists)) game.lists[val] = [];
      }
      else if (key === 'seed'){
        const n = parseInt(val, 10);
        if (isNaN(n)) game.errors.push({ sev:'error', n:i+1, msg:'@seed needs a number' });
        else game.seed = n;
      }
      else if (key === 'format'){
        const n = parseInt(val, 10);
        if (isNaN(n)) game.errors.push({ sev:'error', n:i+1, msg:'@format needs a number' });
        else if (n > TGAME_FORMAT)
          game.errors.push({ sev:'error', n:i+1, msg:'this file needs tgame format ' + n + '; this runtime supports up to ' + TGAME_FORMAT });
        else game.format = n;
      }
      else if (key === 'ignore'){
        game.ignore = val.toLowerCase().split(/[\s,]+/).filter(Boolean);
      }
      else if (key === 'parser'){ game.parserMode = true; }
      else if (key === 'typewriter'){
        const v = val.toLowerCase();
        if (v === 'off'){ game.typewriterEnabled = false; }
        else {
          game.typewriterEnabled = true;
          if (v === 'fast') game.typewriterSpeed = 15;
          else if (v === 'slow') game.typewriterSpeed = 60;
          else if (/^\d+$/.test(v)) game.typewriterSpeed = Math.max(1, parseInt(v, 10));
          else game.typewriterSpeed = 30;
        }
      }
      else { game.meta[key] = val; }
      continue;
    }

    /* ---- passage header:  :: name #tag #tag ---- */
    if (!literal && trimmed.slice(0, 2) === '::'){
      const parts = trimmed.slice(2).trim().split(/\s+/).filter(Boolean);
      const name = parts[0] || '';
      if (!name){ game.errors.push({ sev:'error', n:i+1, msg:'passage needs a name' }); continue; }
      const tags = [];
      for (let k = 1; k < parts.length; k++){
        if (parts[k][0] === '#' && parts[k].length > 1) tags.push(parts[k].slice(1));
        else game.errors.push({ sev:'error', n:i+1, msg:'unexpected "' + parts[k] + '" after the passage name (tags look like #tag)' });
      }
      if (!NAME_FULL.test(name))
        game.errors.push({ sev:'error', n:i+1, msg:'passage name "' + name + '" may only use letters, digits, _ and -' });
      if (name.toLowerCase() === 'end')
        game.errors.push({ sev:'error', n:i+1, msg:'"END" is reserved and cannot be a passage name' });
      const key = name.toLowerCase();
      if (game.passages[key])
        game.errors.push({ sev:'error', n:i+1, msg:'duplicate passage "' + name + '"' });
      cur = { name: name, key: key, n: i + 1, tags: tags, lines: [] };
      game.passages[key] = cur;
      game.order.push(cur);
      continue;
    }

    if (!cur){
      game.errors.push({ sev:'error', n:i+1, msg:'content outside of any passage' });
      continue;
    }
    cur.lines.push({ text: trimmed, raw: raw, n: i + 1, literal: literal });
  }

  if (fence) game.errors.push({ sev:'error', n: fence.n, msg:'unclosed ``` block' });
  if (!('inventory' in game.lists)) game.lists.inventory = [];
  return game;
}

/* ═══════════════════════════════════════════════════════════════════
   EXPRESSIONS — one grammar for conditions, effects and inline text
     or  and  not  ==  !=  <  <=  >  >=  + - * / %
     has ITEM · has no ITEM · LIST has ITEM · visited PASSAGE
     count LIST · inventory · visits · random(lo, hi)
   ═══════════════════════════════════════════════════════════════════ */
const TOKEN_RE = new RegExp(
  '"[^"]*"|\'[^\']*\'|\\d+(?:\\.\\d+)?|' + ID + '|==|!=|<=|>=|&&|\\|\\||[!()<>+\\-*/%,]', 'gu');

function evalExpr(src, ctx){
  ctx = ctx || {};
  const vars    = ctx.vars || {};
  const lists   = ctx.lists || {};
  const visited = ctx.visited || new Set();
  const extras  = ctx.extras || {};
  const rng     = ctx.rng || Math.random;

  const t = String(src).match(TOKEN_RE) || [];
  let p = 0;
  const peek = function(){ return t[p]; };
  const isQuoted = function(k){ return k !== undefined && /^["']/.test(k); };
  const isWord   = function(k){ return k !== undefined && (WORD_RE.test(k) || isQuoted(k)) && k !== 'and' && k !== 'or'; };

  function itemName(){
    const w = [];
    while (p < t.length && isWord(t[p])){
      const k = t[p++];
      w.push(isQuoted(k) ? k.slice(1, -1) : k);
    }
    return w.join(' ');
  }
  function hasTail(list){
    let neg = false;
    if (t[p] === 'no'){ neg = true; p++; }
    const item = itemName();
    if (!item) throw new Error('"has" needs an item name');
    const present = listHas(list, item);
    return neg ? !present : present;
  }

  function primary(){
    const tok = t[p];
    if (tok === undefined) throw new Error('unexpected end of expression');
    if (tok === '('){
      p++;
      const v = or_();
      if (t[p] !== ')') throw new Error('missing )');
      p++;
      return v;
    }
    if (tok === '-'){ p++; return -(+primary()); }
    if (tok === 'has'){ p++; return hasTail(lists.inventory); }
    if (tok === 'visited'){
      p++;
      let name = t[p++];
      if (name === undefined) throw new Error('"visited" needs a passage name');
      while (t[p] === '-' && t[p + 1] !== undefined && WORD_RE.test(t[p + 1])){ name += '-' + t[p + 1]; p += 2; }
      return visited.has(String(name).toLowerCase());
    }
    if (tok === 'random'){
      p++;
      if (t[p] !== '(') throw new Error('random needs (lo, hi)');
      p++;
      const lo = or_();
      if (t[p] !== ',') throw new Error('random needs (lo, hi)');
      p++;
      const hi = or_();
      if (t[p] !== ')') throw new Error('missing ) after random');
      p++;
      return Math.floor(rng() * (hi - lo + 1)) + lo;
    }
    if (tok === 'count'){
      p++;
      const name = t[p++];
      const list = lists[name];
      return list ? list.length : 0;
    }
    if (/^\d/.test(tok)){ p++; return parseFloat(tok); }
    if (isQuoted(tok)){ p++; return tok.slice(1, -1); }
    if (tok === 'true'){ p++; return true; }
    if (tok === 'false'){ p++; return false; }
    if (tok === 'inventory'){ p++; return (lists.inventory || []).length; }
    if (!WORD_RE.test(tok)) throw new Error('unexpected "' + tok + '"');
    p++;
    if (t[p] === 'has' && Object.prototype.hasOwnProperty.call(lists, tok)){
      p++;
      return hasTail(lists[tok]);
    }
    if (extras[tok] !== undefined) return extras[tok];
    return vars[tok] !== undefined ? vars[tok] : 0;
  }
  function mul(){
    let l = primary();
    for (;;){
      const o = peek();
      if (o === '*' || o === '/' || o === '%'){
        p++;
        const r = primary();
        l = o === '*' ? (+l) * (+r) : o === '/' ? (+l) / (+r) : (+l) % (+r);
      } else return l;
    }
  }
  function add(){
    let l = mul();
    for (;;){
      const o = peek();
      if (o === '+' || o === '-'){
        p++;
        const r = mul();
        if (o === '+' && (typeof l === 'string' || typeof r === 'string')) l = String(l) + String(r);
        else l = o === '+' ? (+l) + (+r) : (+l) - (+r);
      } else return l;
    }
  }
  function cmp(){
    const l = add();
    const o = peek();
    if (o === '==' || o === '!=' || o === '<' || o === '<=' || o === '>' || o === '>='){
      p++;
      const r = add();
      return o === '==' ? l == r : o === '!=' ? l != r
           : o === '<'  ? l <  r : o === '<=' ? l <= r
           : o === '>'  ? l >  r : l >= r;
    }
    return l;
  }
  function not_(){
    if (t[p] === 'not' || t[p] === '!'){ p++; return !not_(); }
    return cmp();
  }
  /* both sides are always parsed, so trailing-token errors are never hidden by short-circuiting */
  function and_(){
    let l = not_();
    while (peek() === 'and' || peek() === '&&'){ p++; const r = not_(); l = l && r; }
    return l;
  }
  function or_(){
    let l = and_();
    while (peek() === 'or' || peek() === '||'){ p++; const r = and_(); l = l || r; }
    return l;
  }

  const v = or_();
  if (p < t.length) throw new Error('unexpected "' + t[p] + '"');
  return v;
}

function evalCondition(src, ctx){
  const s = String(src).trim();
  if (!s) return true;
  return !!evalExpr(s, ctx);
}

/* ═══════════════════════════════════════════════════════════════════
   INLINE TEXT  {var}  {a == 1 | one | many}  {if x}..{else}..{end}
   Brace-aware, so branches may nest and contain {other} groups.
   ═══════════════════════════════════════════════════════════════════ */
function matchBrace(s, i){
  let d = 0;
  for (let k = i; k < s.length; k++){
    if (s[k] === '{') d++;
    else if (s[k] === '}'){ d--; if (d === 0) return k; }
  }
  return -1;
}
function findIfBlock(s, from){
  let d = 0, elseAt = -1, elseEnd = -1, i = from;
  while (i < s.length){
    if (s[i] === '{'){
      const c = matchBrace(s, i);
      if (c < 0) return null;
      const inner = s.slice(i + 1, c).trim();
      if (/^if\s/.test(inner)) d++;
      else if (inner === 'end'){
        if (d === 0) return { elseAt: elseAt, elseEnd: elseEnd, endAt: i, endEnd: c + 1 };
        d--;
      }
      else if (inner === 'else' && d === 0 && elseAt < 0){ elseAt = i; elseEnd = c + 1; }
      i = c + 1;
      continue;
    }
    i++;
  }
  return null;
}
function interp(s, ctx){ return renderInline(String(s), ctx, 0); }
function renderInline(s, ctx, depth){
  if (depth > 40) return s;
  let out = '', i = 0;
  while (i < s.length){
    const c = s[i];
    if (c !== '{'){ out += c; i++; continue; }
    const close = matchBrace(s, i);
    if (close < 0){ out += s.slice(i); break; }
    const inner = s.slice(i + 1, close).trim();
    if (/^if\s/.test(inner)){
      const blk = findIfBlock(s, close + 1);
      if (!blk){ i = close + 1; continue; }              /* unclosed {if}: dropped (the linter warns) */
      let on = false;
      try { on = evalCondition(inner.slice(3).trim(), ctx); } catch(e){ on = false; }
      const yes = s.slice(close + 1, blk.elseAt >= 0 ? blk.elseAt : blk.endAt);
      const no  = blk.elseAt >= 0 ? s.slice(blk.elseEnd, blk.endAt) : '';
      out += renderInline(on ? yes : no, ctx, depth + 1);
      i = blk.endEnd;
      continue;
    }
    out += expandInterp(inner, ctx, depth);
    i = close + 1;
  }
  return out;
}
function expandInterp(inner, ctx, depth){
  if (!inner) return '';
  const lists  = ctx.lists || {};
  const visits = ctx.visits || {};
  let m;
  if ((m = inner.match(/^count\s+(\S+)$/))){
    const list = lists[m[1]];
    return list ? String(list.length) : '0';
  }
  if (inner === 'inventory') return (lists.inventory || []).join(', ');
  if (inner === 'visits') return String(visits[ctx.currentPassage] || 0);
  const parts = splitTopLevel(inner, ['|']);
  if (parts.length === 3 || parts.length === 2){
    let cond;
    try { cond = evalCondition(parts[0].trim(), ctx); } catch(e){ cond = false; }
    const yes = parts[1].trim();
    const no  = parts.length === 3 ? parts[2].trim() : '';
    return renderInline(cond ? yes : no, ctx, depth + 1);
  }
  if (ID_FULL.test(inner)){
    const extras = ctx.extras || {};
    if (extras[inner] !== undefined) return String(extras[inner]);
    if (Object.prototype.hasOwnProperty.call(lists, inner)) return lists[inner].join(', ');
    const v = (ctx.vars || {})[inner];
    return v !== undefined ? String(v) : '';
  }
  try {
    const v = evalExpr(inner, ctx);
    return v === undefined ? '' : String(v);
  } catch(e){ return ''; }
}

/* ═══════════════════════════════════════════════════════════════════
   EFFECTS   [get lamp, score += 5, clues add footprints, once …]
   ═══════════════════════════════════════════════════════════════════ */
const RX_LIST_OP   = rx('^(<ID>)\\s+(add|remove)\\s+(.+?)$');
const RX_LIST_CLR  = rx('^(<ID>)\\s+clear$');
const RX_ASSIGN    = rx('^(<ID>)\\s*(\\+=|-=|\\*=|/=|%=|=)\\s*([\\s\\S]*)$');
const RX_INCDEC    = rx('^(<ID>)\\s*(\\+\\+|--)$');

function applyEffects(src, ctx){
  const vars  = ctx.vars  || (ctx.vars = {});
  const lists = ctx.lists || (ctx.lists = {});
  const parts = splitTopLevel(String(src), [',', ';'], true);

  for (let i = 0; i < parts.length; i++){
    const e = parts[i].trim();
    if (!e) continue;
    let m;

    if ((m = e.match(/^get\s+(.+?)$/))){
      const item = m[1].trim();
      lists.inventory = lists.inventory || [];
      if (item && !listHas(lists.inventory, item)) lists.inventory.push(item);
      continue;
    }
    if ((m = e.match(/^drop\s+(.+?)$/))){
      const inv = lists.inventory || [];
      const idx = listIndex(inv, m[1].trim());
      if (idx >= 0) inv.splice(idx, 1);
      continue;
    }
    if (e === 'clear inventory'){
      if (lists.inventory) lists.inventory.length = 0;
      continue;
    }
    if ((m = e.match(RX_LIST_OP))){
      const name = m[1], item = m[3].trim();
      if (!lists[name]) throw new Error('unknown list "' + name + '"');
      if (m[2] === 'add'){ if (item && !listHas(lists[name], item)) lists[name].push(item); }
      else { const idx = listIndex(lists[name], item); if (idx >= 0) lists[name].splice(idx, 1); }
      continue;
    }
    if ((m = e.match(RX_LIST_CLR))){
      if (!lists[m[1]]) throw new Error('unknown list "' + m[1] + '"');
      lists[m[1]].length = 0;
      continue;
    }
    if ((m = e.match(RX_INCDEC))){
      vars[m[1]] = (+vars[m[1]] || 0) + (m[2] === '++' ? 1 : -1);
      continue;
    }
    if ((m = e.match(RX_ASSIGN))){
      const name = m[1], op = m[2];
      const val = evalExpr(m[3], ctx);
      const cur = vars[name];
      if (op === '=') vars[name] = val;
      else if (op === '+=' && (typeof cur === 'string' || typeof val === 'string'))
        vars[name] = (cur === undefined ? '' : String(cur)) + String(val);
      else {
        const a = +cur || 0, b = +val || 0;
        vars[name] = op === '+=' ? a + b : op === '-=' ? a - b : op === '*=' ? a * b : op === '/=' ? a / b : a % b;
      }
      continue;
    }
    throw new Error('unrecognized effect "' + e + '"');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CHOICES
     * Label | alias, alias -> target [effects]
   ═══════════════════════════════════════════════════════════════════ */
function splitChoice(line){
  const s = line.slice(1).trim();
  let label = s, target = null, effects = '';
  const arrow = s.indexOf('->');
  if (arrow >= 0){
    label = s.slice(0, arrow).trim();
    const rest = s.slice(arrow + 2).trim();
    const ob = rest.indexOf('[');
    if (ob >= 0 && rest.endsWith(']')){
      target = rest.slice(0, ob).trim();
      effects = rest.slice(ob + 1, -1).trim();
    } else target = rest;
  } else {
    const ob = s.indexOf('[');
    if (ob >= 0 && s.endsWith(']')){
      label = s.slice(0, ob).trim();
      effects = s.slice(ob + 1, -1).trim();
    }
  }
  return { label: label, target: target, effects: effects };
}

function parseChoice(line, ctx){
  const sc = splitChoice(line);
  const labelParts = splitTopLevel(sc.label, ['|']);
  const label = labelParts[0].trim();
  if (!label) return null;
  const render = function(x){ return unescapeText(interp(x, ctx)); };

  let once = false;
  const keep = [];
  splitTopLevel(sc.effects, [',', ';'], true).forEach(function(part){
    if (part.trim() === 'once') once = true;
    else if (part.trim()) keep.push(part.trim());
  });

  return {
    label: render(label),
    aliases: labelParts.slice(1).map(function(a){ return render(a.trim()); }).filter(Boolean),
    target: sc.target,
    effects: keep.join(', '),
    once: once
  };
}

/* typed input → choice.  Numbers, exact label/alias, then word-subsequence.
   More than one candidate is reported as ambiguous instead of silently picking one. */
function normPhrase(s, ignore){
  const ig = {};
  (ignore || []).forEach(function(w){ ig[w] = 1; });
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(function(w){ return w && !ig[w]; }).join(' ');
}
function isSubseq(a, b){
  if (!a.length) return false;
  let j = 0;
  for (let i = 0; i < b.length; i++){ if (b[i] === a[j]) j++; if (j === a.length) return true; }
  return false;
}
function matchChoice(input, choices, ignore){
  const raw = String(input).trim();
  if (/^\d+$/.test(raw)){
    const i = parseInt(raw, 10) - 1;
    return (i >= 0 && i < choices.length) ? { index: i } : { none: true };
  }
  const q = normPhrase(raw, ignore);
  if (!q) return { none: true };
  const forms = choices.map(function(c){
    return [c.label].concat(c.aliases || []).map(function(f){ return normPhrase(f, ignore); }).filter(Boolean);
  });
  const exact = [];
  forms.forEach(function(fs, i){ if (fs.indexOf(q) >= 0) exact.push(i); });
  if (exact.length === 1) return { index: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const qw = q.split(' ');
  const part = [];
  forms.forEach(function(fs, i){ if (fs.some(function(f){ return isSubseq(qw, f.split(' ')); })) part.push(i); });
  if (part.length === 1) return { index: part[0] };
  if (part.length > 1) return { ambiguous: part };
  return { none: true };
}

/* ═══════════════════════════════════════════════════════════════════
   INTERPRETER
   Deterministic: given the same source, seed and sequence of inputs the
   run is identical. That is what makes save / restore / undo possible —
   a save is {seed, history}, and loading replays it.
   ═══════════════════════════════════════════════════════════════════ */
function Interp(game, opts){
  opts = opts || {};
  this.game = game;
  this.skipEffects = !!opts.skipEffects;
  this.seed = (opts.seed != null) ? (opts.seed | 0)
            : (game.seed != null) ? (game.seed | 0)
            : ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
  this.rng = mulberry32(this.seed);
  this.vars = {};
  this.lists = {};
  for (const k in game.lists) this.lists[k] = game.lists[k].slice();
  this.visited = new Set();
  this.visits = {};
  this.used = new Set();            /* once-only choices and [once …] lines already spent */
  this.passage = null;
  this.steps = 0;
  this._last = null;
  this.typewriter = !!game.typewriterEnabled;
  this.typewriterSpeed = game.typewriterSpeed || 30;

  const ctx = this.ctx();
  for (let i = 0; i < game.inits.length; i++){
    try { this.vars[game.inits[i].name] = evalExpr(game.inits[i].src, ctx); }
    catch(e){ this.vars[game.inits[i].name] = 0; }
  }
}

Interp.prototype.ctx = function(){
  const self = this;
  return {
    vars: self.vars,
    lists: self.lists,
    visited: self.visited,
    visits: self.visits,
    currentPassage: self.passage,
    extras: { visits: self.visits[self.passage] || 0 },
    rng: function(){ return self.rng(); }
  };
};

/* Runs the lines of one passage (or one >> snippet). Returns {jump, choices, stop}. */
Interp.prototype.runLines = function*(pass, ctx, o){
  const self = this;
  const g = this.game;
  const legacy = g.format === 2;               /* format 2: every line is its own paragraph */
  const choices = [];
  const stack = [];
  let jump = null;
  let buf = '', have = false, hard = false;

  const live = function(){
    if (!stack.length) return true;
    const top = stack[stack.length - 1];
    return top.parentLive && top.taken;
  };
  const mkText = function(raw, style){
    return {
      type: 'text', text: unescapeText(raw), html: fmtHTML(raw), style: style,
      typewriter: !style && self.typewriter && !self.skipEffects,
      speed: self.typewriterSpeed
    };
  };
  const flush = function*(){
    if (!have) return;
    const raw = buf;
    buf = ''; have = false; hard = false;
    yield mkText(raw);
  };
  const addText = function*(raw){
    if (legacy){ yield mkText(raw); return; }
    let hb = false;
    if (raw.charAt(raw.length - 1) === '\\'){ raw = raw.slice(0, -1).replace(/\s+$/, ''); hb = true; }
    if (have) buf += (hard ? '\n' : ' ') + raw;
    else { buf = raw; have = true; }
    hard = hb;
  };

  scan: for (let li = 0; li < pass.lines.length; li++){
    const item = pass.lines[li];
    const k = classifyLine(item);
    const t = item.text;
    try {
      if (k.kind === 'if'){
        yield* flush();
        const isLive = live();
        const cond = isLive && !!evalCondition(k.cond, ctx);
        stack.push({ parentLive: isLive, taken: cond });
        continue;
      }
      if (k.kind === 'else'){
        if (!stack.length) throw new Error('else without if');
        yield* flush();
        const top = stack[stack.length - 1];
        if (top.parentLive) top.taken = !top.taken;
        continue;
      }
      if (k.kind === 'end'){
        if (!stack.length) throw new Error('end without if');
        yield* flush();
        stack.pop();
        continue;
      }
      if (!live()) continue;

      switch (k.kind){
        case 'blank':
          yield* flush();
          break;

        case 'verbatim':
          yield* flush();
          yield { type:'text', text: item.verbatim, html: escHtml(item.verbatim), style:'pre', typewriter:false, speed: self.typewriterSpeed };
          break;

        case 'text':
        case 'badmode':
          yield* addText(interp(t, ctx));
          break;

        case 'pause':
          yield* flush();
          if (!self.skipEffects && k.ms > 0) yield { type:'pause', ms: k.ms };
          break;

        case 'mode':
          yield* flush();
          if (k.mode === 'type'){ self.typewriter = true; }
          else if (k.mode === 'normal'){ self.typewriter = false; }
          else if (k.mode === 'fast'){ self.typewriter = true; self.typewriterSpeed = 15; }
          else if (k.mode === 'slow'){ self.typewriter = true; self.typewriterSpeed = 60; }
          break;

        case 'input': {
          yield* flush();
          const spec = parsePromptLine(t);
          if (!spec) throw new Error('malformed ? directive');
          if (spec.prompt) yield mkText(interp(spec.prompt, ctx), 'prompt');
          let answer;
          for (;;){
            answer = yield { type:'input', varName: spec.varName, prompt: spec.prompt, vtype: spec.vtype };
            const s = String(answer == null ? '' : answer).trim();
            if (spec.vtype === 'number' && !/^-?\d+(\.\d+)?$/.test(s)){
              yield { type:'text', text:'Please enter a number.', html:'Please enter a number.', style:'sys' };
              continue;
            }
            break;
          }
          if (spec.varName){
            const s = String(answer == null ? '' : answer).trim();
            if (spec.vtype === 'text') self.vars[spec.varName] = s;
            else if (spec.vtype === 'number') self.vars[spec.varName] = Number(s);
            else self.vars[spec.varName] = (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) ? Number(s) : s;
          }
          if (spec.target){
            if (o.snippet) throw new Error('-> is not allowed in a >> snippet');
            jump = spec.target;
            break scan;
          }
          break;
        }

        case 'choice': {
          yield* flush();
          if (o.snippet) throw new Error('choices are not allowed in a >> snippet');
          const c = parseChoice(t, ctx);
          if (!c) throw new Error('malformed choice');
          c.n = item.n;
          if (c.once && self.used.has('c' + item.n)) break;      /* already taken: hidden */
          choices.push(c);
          break;
        }

        case 'jump':
          yield* flush();
          if (o.snippet) throw new Error('-> is not allowed in a >> snippet');
          jump = k.target;
          break scan;

        case 'call': {
          yield* flush();
          const sub = g.passages[k.target.toLowerCase()];
          if (!sub) throw new Error('>> missing passage "' + k.target + '"');
          if (o.depth >= 32) throw new Error('>> nested too deeply');
          const r = yield* self.runLines(sub, ctx, { snippet: true, depth: o.depth + 1, entering: o.entering });
          if (r.stop) return r;
          break;
        }

        case 'effect': {
          let src = k.src;
          const m = src.trim().match(/^(once|enter)\s+([\s\S]+)$/);
          if (m){
            if (m[1] === 'once'){
              if (self.used.has('e' + item.n)) break;
              self.used.add('e' + item.n);
            } else if (!o.entering) break;                        /* [enter …] only on arrival */
            src = m[2];
          }
          applyEffects(src, ctx);
          break;
        }
      }
    } catch(e){
      yield { type:'error', text:'line ' + item.n + ': ' + e.message };
      return { stop: true };
    }
  }
  yield* flush();
  return { jump: jump, choices: choices, stop: false };
};

Interp.prototype.run = function*(){
  const g = this.game;
  let cur = (g.meta.start || (g.order[0] && g.order[0].key) || '').toLowerCase();
  if (!cur){ yield { type:'error', text:'no passages defined' }; return; }

  for (;;){
    if (++this.steps > 500000){ yield { type:'error', text:'step limit exceeded' }; return; }
    const pass = g.passages[cur];
    if (!pass){ yield { type:'error', text:'missing passage: "' + cur + '"' }; return; }
    this.passage = cur;

    const entering = cur !== this._last;
    if (entering){
      this.visited.add(cur);
      this.visits[cur] = (this.visits[cur] || 0) + 1;
    }
    this._last = cur;

    const ctx = this.ctx();
    const res = yield* this.runLines(pass, ctx, { snippet: false, depth: 0, entering: entering });
    if (res.stop) return;

    if (res.jump !== null){
      if (res.jump.toUpperCase() === 'END'){ yield { type:'end' }; return; }
      cur = res.jump.toLowerCase();
      continue;
    }
    if (!res.choices.length){ yield { type:'end' }; return; }

    const i = yield { type:'choice', choices: res.choices, passage: cur, parserMode: g.parserMode };
    const c = res.choices[i];
    if (!c){ yield { type:'error', text:'invalid choice' }; return; }
    if (c.once) this.used.add('c' + c.n);
    if (c.effects){
      try { applyEffects(c.effects, this.ctx()); }
      catch(e){ yield { type:'error', text:'line ' + c.n + ': ' + e.message }; return; }
    }
    if (c.target){
      if (c.target.toUpperCase() === 'END'){ yield { type:'end' }; return; }
      cur = c.target.toLowerCase();
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   REFERENCE PLAYER (DOM)
   Used by both the IDE and every exported standalone game.
     new TgamePlayer({ out, choices, form, input, scroll?,
                       onStart?, onReset?, onChoice?, onEnd? })
     player.start(game, { skipEffects?, seed?, replay?, hash? })
     player.undo()  player.saveSlot()  player.loadSlot()
   ═══════════════════════════════════════════════════════════════════ */
function TgamePlayer(cfg){
  const self = this;
  this.cfg = cfg;
  this.out = cfg.out;
  this.choicesEl = cfg.choices;
  this.form = cfg.form;
  this.input = cfg.input;
  this.run = 0;
  this.game = null;
  this.interp = null;
  this.gen = null;
  this.opts = {};
  this.history = [];
  this.replayQ = null;
  this.pending = null;
  this.awaiting = null;
  this.tw = null;
  this.ended = false;
  this.reduced = !!(typeof window !== 'undefined' && window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  this.form.addEventListener('submit', function(e){
    e.preventDefault();
    self.submit(self.input.value);
  });
}

TgamePlayer.prototype.scroll = function(){
  if (this.cfg.scroll) this.cfg.scroll();
  else this.out.scrollTop = this.out.scrollHeight;
};

TgamePlayer.prototype.print = function(text, cls){
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = text;
  this.out.appendChild(p);
  this.scroll();
  return p;
};

TgamePlayer.prototype.printEvent = function(v){
  if (v.style === 'pre'){
    const pre = document.createElement('pre');
    pre.className = 'pre';
    pre.textContent = v.text;
    this.out.appendChild(pre);
    this.scroll();
    return;
  }
  if (v.style === 'sys'){ this.print(v.text, 'sys'); return; }
  const p = document.createElement('p');
  if (v.style === 'prompt') p.className = 'prompt';
  p.innerHTML = v.html;
  this.out.appendChild(p);
  this.scroll();
};

/* progressive reveal; clicking the output finishes the paragraph */
TgamePlayer.prototype.typewrite = function(html, speed, done){
  const self = this;
  const p = document.createElement('p');
  p.className = 'tw';
  p.innerHTML = html;
  this.out.appendChild(p);

  const chars = [];
  const nodes = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (let i = 0; i < nodes.length; i++){
    const tn = nodes[i];
    const frag = document.createDocumentFragment();
    const value = tn.nodeValue;
    for (let j = 0; j < value.length; j++){
      const span = document.createElement('span');
      span.textContent = value[j];
      span.style.visibility = 'hidden';
      frag.appendChild(span);
      chars.push(span);
    }
    tn.parentNode.replaceChild(frag, tn);
  }
  let i = 0, finished = false, timer = null;
  function finish(){
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    for (let k = i; k < chars.length; k++) chars[k].style.visibility = 'visible';
    self.out.removeEventListener('click', finish);
    self.tw = null;
    done();
  }
  timer = setInterval(function(){
    if (i >= chars.length){ finish(); return; }
    chars[i].style.visibility = 'visible';
    i++;
    self.scroll();
  }, Math.max(1, speed));
  this.out.addEventListener('click', finish);
  this.tw = { finish: finish };
};

TgamePlayer.prototype.reset = function(){
  this.run++;
  if (this.tw){ const t = this.tw; this.tw = null; t.finish(); }
  this.out.innerHTML = '';
  this.choicesEl.innerHTML = '';
  this.form.style.display = '';
  this.form.classList.remove('awaiting');
  this.input.value = '';
  this.pending = null;
  this.awaiting = null;
  this.ended = false;
  if (this.cfg.onReset) this.cfg.onReset();
};

TgamePlayer.prototype.start = function(game, opts){
  opts = opts || {};
  this.reset();
  const my = this.run;
  this.game = game;
  this.opts = { skipEffects: !!opts.skipEffects, hash: opts.hash || '' };
  this.history = [];
  this.replayQ = opts.replay ? opts.replay.slice() : null;
  const interp = new Interp(game, {
    skipEffects: this.opts.skipEffects || !!(this.replayQ && this.replayQ.length),
    seed: opts.seed
  });
  this.interp = interp;
  this.gen = interp.run();
  if (this.cfg.onStart) this.cfg.onStart(interp);
  this.advance(my);
  return interp;
};

TgamePlayer.prototype.replayDone = function(){
  this.replayQ = null;
  this.interp.skipEffects = this.opts.skipEffects;
};

TgamePlayer.prototype.advance = function(my, input){
  const self = this;
  for (;;){
    if (my !== this.run) return;
    let r;
    try { r = this.gen.next(input); }
    catch(e){ this.print('runtime error: ' + e.message, 'err'); this.finish(); return; }
    input = undefined;
    if (r.done){ this.finish(); return; }
    const v = r.value;

    if (v.type === 'text'){
      if (v.typewriter && !this.reduced){
        this.typewrite(v.html, v.speed || 30, function(){ self.advance(my); });
        return;
      }
      this.printEvent(v);
      continue;
    }
    if (v.type === 'pause'){
      setTimeout(function(){ self.advance(my); }, v.ms);
      return;
    }
    if (v.type === 'end'){ this.finish(); return; }
    if (v.type === 'error'){ this.print('*** ' + v.text, 'err'); this.finish(); return; }

    if (v.type === 'input'){
      if (this.replayQ && this.replayQ.length){
        const e = this.replayQ.shift();
        if (e.t !== 'i'){ this.print('*** the save no longer matches this story', 'err'); this.finish(); return; }
        this.print('> ' + e.v, 'echo');
        this.history.push(e);
        input = e.v;
        continue;
      }
      if (this.replayQ) this.replayDone();
      this.form.classList.add('awaiting');
      this.input.placeholder = 'type your answer…';
      this.input.value = '';
      this.input.focus();
      this.awaiting = function(answer){ self.advance(my, answer); };
      return;
    }

    if (v.type === 'choice'){
      if (this.replayQ && this.replayQ.length){
        const e = this.replayQ.shift();
        if (e.t !== 'c' || !v.choices[e.i]){ this.print('*** the save no longer matches this story', 'err'); this.finish(); return; }
        this.print('> ' + v.choices[e.i].label, 'echo');
        this.history.push(e);
        input = e.i;
        continue;
      }
      if (this.replayQ) this.replayDone();
      this.pending = v;
      this.renderChoices(v);
      if (this.cfg.onChoice) this.cfg.onChoice(this.interp, v.passage);
      return;
    }
  }
};

TgamePlayer.prototype.finish = function(){
  this.print('— The End —', 'end');
  this.form.style.display = 'none';
  this.choicesEl.innerHTML = '';
  this.pending = null;
  this.awaiting = null;
  this.ended = true;
  if (this.cfg.onEnd) this.cfg.onEnd(this.interp);
};

TgamePlayer.prototype.renderChoices = function(v){
  const self = this;
  this.choicesEl.innerHTML = '';
  if (v.parserMode){
    this.input.placeholder = 'type a command (try "help")…';
  } else {
    v.choices.forEach(function(c, i){
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i + 1) + '.';
      const lab = document.createElement('span');
      lab.textContent = c.label;
      b.appendChild(num);
      b.appendChild(lab);
      b.onclick = function(){ self.pick(i); };
      li.appendChild(b);
      self.choicesEl.appendChild(li);
    });
    this.input.placeholder = 'type a command or number…';
  }
  const ae = document.activeElement;
  const typing = ae && ae !== this.input &&
    (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  if (!typing) this.input.focus({ preventScroll: true });
};

TgamePlayer.prototype.pick = function(i){
  const p = this.pending;
  if (!p || !p.choices[i]) return;
  this.pending = null;
  this.choicesEl.innerHTML = '';
  this.print('> ' + p.choices[i].label, 'echo');
  this.history.push({ t:'c', i: i });
  this.advance(this.run, i);
};

TgamePlayer.prototype.help = function(){
  const p = this.pending;
  const extra = 'Also: undo · save · load';
  if (!p){ this.print(extra, 'sys'); return; }
  this.print('Commands available here:', 'sys');
  p.choices.forEach(function(c, i){
    this.print('  ' + (i + 1) + '  ' + c.label + (c.aliases && c.aliases.length ? '   (' + c.aliases.join(', ') + ')' : ''), 'sys');
  }, this);
  this.print(extra, 'sys');
};

TgamePlayer.prototype.submit = function(text){
  if (this.tw) this.tw.finish();
  const v = String(text == null ? '' : text);

  if (this.awaiting){
    const a = this.awaiting;
    this.awaiting = null;
    this.form.classList.remove('awaiting');
    this.input.value = '';
    this.input.placeholder = 'type a command or number…';
    this.print('> ' + v, 'echo');
    this.history.push({ t:'i', v: v });
    a(v);
    return;
  }

  const trimmed = v.trim();
  if (!trimmed) return;
  const low = trimmed.toLowerCase();
  this.input.value = '';

  if (low === 'help' || low === '?'){ this.help(); return; }
  if (low === 'undo'){ this.undo(); return; }
  if (low === 'save'){ this.saveSlot(); return; }
  if (low === 'load' || low === 'restore'){ this.loadSlot(); return; }
  if (!this.pending) return;

  const m = matchChoice(trimmed, this.pending.choices, this.game.ignore);
  if (m.index != null){ this.pick(m.index); return; }
  if (m.ambiguous){
    const labels = m.ambiguous.map(function(i){ return this.pending.choices[i].label; }, this);
    this.print('Which do you mean? ' + labels.join(' / '), 'sys');
    return;
  }
  this.print('I don\'t understand "' + trimmed + '".', 'sys');
};

/* ── undo / save / restore: all done by deterministic replay ── */
TgamePlayer.prototype.undo = function(){
  if (!this.game || !this.history.length){ this.print('Nothing to undo.', 'sys'); return false; }
  this.start(this.game, {
    seed: this.interp.seed,
    replay: this.history.slice(0, -1),
    skipEffects: this.opts.skipEffects,
    hash: this.opts.hash
  });
  return true;
};
TgamePlayer.prototype.slotKey = function(){
  return 'tgame.save:' + ((this.game && this.game.meta.title) || 'untitled');
};
TgamePlayer.prototype.saveData = function(){
  return { v: 1, title: this.game.meta.title || '', seed: this.interp.seed,
           hash: this.opts.hash || '', history: this.history.slice() };
};
TgamePlayer.prototype.saveSlot = function(){
  if (!this.game) return false;
  try {
    localStorage.setItem(this.slotKey(), JSON.stringify(this.saveData()));
    this.print('Game saved.', 'sys');
    return true;
  } catch(e){
    this.print('Could not save: ' + e.message, 'err');
    return false;
  }
};
TgamePlayer.prototype.loadSlot = function(){
  if (!this.game) return false;
  let raw = null;
  try { raw = localStorage.getItem(this.slotKey()); } catch(e){}
  if (!raw){ this.print('No saved game found.', 'sys'); return false; }
  let d;
  try { d = JSON.parse(raw); } catch(e){ this.print('The saved game is damaged.', 'err'); return false; }
  return this.loadData(d);
};
TgamePlayer.prototype.loadData = function(d){
  if (!d || d.v !== 1 || !Array.isArray(d.history)){ this.print('Not a valid saved game.', 'err'); return false; }
  const changed = d.hash && this.opts.hash && d.hash !== this.opts.hash;
  this.start(this.game, {
    seed: d.seed, replay: d.history,
    skipEffects: this.opts.skipEffects, hash: this.opts.hash
  });
  if (changed) this.print('Note: the story changed since this save, so it may not line up.', 'sys');
  return true;
};
