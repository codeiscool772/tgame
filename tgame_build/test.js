const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = __dirname;
const rt = fs.readFileSync(path.join(dir, 'runtime.js'), 'utf8');
const lt = fs.readFileSync(path.join(dir, 'lint.js'), 'utf8');
const api = new Function(rt + '\n' + lt +
  '\nreturn {parse,lint,Interp,evalExpr,matchChoice,interp,classifyLine,fmtHTML,escHtml,applyEffects,mulberry32,hashStr,TgamePlayer,TGAME_FORMAT};')();

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* headless play: inputs are numbers (choice index) or strings (typed answers) */
function play(src, inputs, opts){
  opts = opts || {};
  const game = api.parse(src);
  const it = new api.Interp(game, opts);
  const gen = it.run();
  const log = []; let ended = false, error = null, lastChoices = null;
  inputs = (inputs || []).slice();
  let r = gen.next();
  for (let guard = 0; guard < 5000 && !r.done; guard++){
    const v = r.value;
    if (v.type === 'text') log.push(v.style === 'pre' ? '[pre]' + v.text : v.text);
    if (v.type === 'error'){ error = v.text; break; }
    if (v.type === 'end'){ ended = true; }
    if (v.type === 'choice'){ lastChoices = v.choices.map(c => c.label); if (!inputs.length) break; r = gen.next(inputs.shift()); continue; }
    if (v.type === 'input'){ if (!inputs.length) break; r = gen.next(inputs.shift()); continue; }
    r = gen.next();
  }
  return { log, ended, error, lastChoices, it, game };
}
const lintMsgs = src => api.lint(api.parse(src)).map(p => p.sev + ':' + p.msg);

console.log('\n1. @parser mode / matching');
{
  const ch = [{label:'Look at the lamp', aliases:[]}, {label:'Take the lamp', aliases:['get lamp','grab lamp']}, {label:'Open the door', aliases:['go east']}];
  const ig = ['the','a','an'];
  ok('exact label', api.matchChoice('open the door', ch, ig).index === 2);
  ok('alias', api.matchChoice('grab lamp', ch, ig).index === 1);
  ok('articles ignored', api.matchChoice('take lamp', ch, ig).index === 1);
  ok('unique partial', api.matchChoice('door', ch, ig).index === 2);
  ok('ambiguous reported, not silently picked', Array.isArray(api.matchChoice('lamp', ch, ig).ambiguous));
  ok('number', api.matchChoice('2', ch, ig).index === 1);
  ok('none', api.matchChoice('dance', ch, ig).none === true);
  ok('non-latin labels work', api.matchChoice('écouter', [{label:'Écouter'}], ig).index === 0);
}

console.log('\n2. Your Name example flows through');
{
  const src = api.parse ? fs.readFileSync(path.join(dir, 'examples_section.js'), 'utf8') : '';
  const m = src.match(/name: \{[\s\S]*?source: String\.raw`([\s\S]*?)`\n  \}/);
  const r = play(m[1], ['Ada', '70']);
  ok('reaches the end', r.ended, r.error);
  ok('uses typed name', r.log.some(l => l.includes('Welcome, Ada')));
  ok('number branch', r.log.some(l => l.includes('A long road')));
  const r2 = play(m[1], ['Bob', 'abc', '20']);
  ok('number type re-asks', r2.log.some(l => l.includes('Please enter a number')) && r2.ended);
  ok('lint clean', lintMsgs(m[1]).length === 0, lintMsgs(m[1]));
}

console.log('\n3. not / and / or precedence, one grammar');
{
  const ctx = { vars:{score:3}, lists:{inventory:['Lamp']}, visited:new Set(['village']), extras:{visits:2} };
  ok('not has X and Y  ==  (not has X) and Y', api.evalExpr('not has lamp and score > 1', ctx) === false);
  ok('not has missing and score>1', api.evalExpr('not has key and score > 1', ctx) === true);
  ok('has is case-insensitive', api.evalExpr('has LAMP', ctx) === true);
  ok('has no', api.evalExpr('has no key', ctx) === true);
  ok('visited', api.evalExpr('visited village', ctx) === true);
  ok('visits', api.evalExpr('visits == 2', ctx) === true);
  ok('false and X or true parses fully', api.evalExpr('false and score > 1 or true', ctx) === true);
  ok('trailing junk is an error', (() => { try { api.evalExpr('score score', ctx); return false; } catch(e){ return true; } })());
  const c2 = { vars:{}, lists:{inventory:['lamp'], clues:['footprints']}, extras:{} };
  ok('LIST has ITEM', api.evalExpr('clues has footprints', c2) === true);
  ok('has works inside inline ternary', api.interp('{has lamp | yes | no}', c2) === 'yes');
}

console.log('\n4. inline {if} nesting');
{
  const c = { vars:{a:1,n:7}, lists:{inventory:['lamp','key']}, extras:{}, visits:{}, currentPassage:'x' };
  ok('braces inside branch', api.interp('{if has lamp}You hold {count inventory} items{end}.', c) === 'You hold 2 items.');
  ok('else branch', api.interp('{if has sword}S{else}no sword, n={n}{end}', c) === 'no sword, n=7');
  ok('nested ifs', api.interp('{if a == 1}A{if n > 5}B{else}C{end}D{else}E{end}', c) === 'ABD');
  ok('ternary with nested group', api.interp('{a == 1 | one {n} | many}', c) === 'one 7');
}

console.log('\n5. linter false positives gone');
{
  const cave = fs.readFileSync(path.join(dir, 'examples_section.js'), 'utf8').match(/cave: \{[\s\S]*?source: String\.raw`([\s\S]*?)`\n  \}/)[1];
  ok('Cave: no problems', lintMsgs(cave).length === 0, lintMsgs(cave));
  const bad = ':: a\nif has lamp and visited b:\nx\nend\n:: b\ny\n-> END';
  ok('has/visited names not flagged as variables', !lintMsgs('@format 3\n@start a\n' + bad).some(m => /never declared/.test(m)), lintMsgs('@format 3\n@start a\n' + bad));
  ok('typo gets did-you-mean', lintMsgs('@format 3\n@set Score = 0\n:: a\n{score}\n-> END').some(m => /did you mean "Score"/.test(m)));
  ok('bad effect flagged', lintMsgs('@format 3\n:: a\n* x -> END [wave]').some(m => /unrecognized effect/.test(m)));
  ok('unknown mode flagged', lintMsgs('@format 3\n:: a\n~bogus\n-> END').some(m => /unknown mode/.test(m)));
  ok('missing @format warned', lintMsgs(':: a\nhi\n-> END').some(m => /@format/.test(m)));
}

console.log('\n6. determinism / RNG');
{
  const src = '@format 3\n@set r = random(1, 6)\n:: a\n{r}\n* go -> b\n:: b\n[x = random(1,1000000)]\n{x}\n-> END';
  const a = play(src, [0], { seed: 99 }), b = play(src, [0], { seed: 99 }), c = play(src, [0], { seed: 100 });
  ok('same seed, same game (incl. @set)', JSON.stringify(a.log) === JSON.stringify(b.log));
  ok('different seed differs', JSON.stringify(a.log) !== JSON.stringify(c.log));
  const rng = api.mulberry32(12345); let max = 0, min = 1;
  for (let i = 0; i < 200000; i++){ const v = rng(); if (v > max) max = v; if (v < min) min = v; }
  ok('rng stays in [0,1)', min >= 0 && max < 1);
  const ctx = { vars:{}, lists:{}, rng: () => 0.99999999 };
  ok('random(1,6) never exceeds 6', api.evalExpr('random(1,6)', ctx) === 6);
}

console.log('\n7. names, escapes, comments, text layout');
{
  ok('quote in passage name is an error', lintMsgs('@format 3\n:: x" onmouseover="alert(1)\nhi').some(m => /may only use|unexpected/.test(m)));
  ok('END reserved', lintMsgs('@format 3\n:: end\nhi').some(m => /reserved/.test(m)));
  ok('unicode passage + var names', play('@format 3\n@set puntos = 2\n:: inicio\n{puntos} puntos\n-> END').log[0] === '2 puntos');
  const p1 = play('@format 3\n:: a\nline one\nline two\n\nnext para\nhard\\\nbreak\n-> END').log;
  ok('lines join, blank line splits, backslash = hard break', JSON.stringify(p1) === JSON.stringify(['line one line two','next para hard\nbreak']), p1);
  const p2 = play('@format 2\n:: a\nline one\nline two\n-> END').log;
  ok('format 2 keeps line-per-paragraph', p2.length === 2);
  const p3 = play('@format 3\n:: a\n\\if you go there:\n\\end\n\\// not a comment\n-> END').log;
  ok('leading backslash escapes keyword + // lines', JSON.stringify(p3) === JSON.stringify(['if you go there: end // not a comment']), p3);
  const p4 = play('@format 3\n:: a\nsee http://x.y // here\n-> END').log;
  ok('// mid-line is plain text', p4[0] === 'see http://x.y // here', p4);
  const p5 = play('@format 3\n:: a\n```\n  art {x}\n    more\n```\ndone\n-> END').log;
  ok('verbatim fence keeps indentation, no interpolation', p5[0] === '[pre]  art {x}\n    more' && p5[1] === 'done', p5);
  ok('escaped asterisk is not italics', api.fmtHTML('a \uE001b\uE001 c').indexOf('<em>') < 0);
  ok('html is escaped incl. quotes', api.escHtml('"<&>\'') === '&quot;&lt;&amp;&gt;&#39;');
}

console.log('\n8. once / enter / snippets / tags / list ops');
{
  const src = '@format 3\n@set n = 0\n@list notes\n:: a #hub #x\n[enter n += 1]\n[once n += 10]\nn={n}\n>> snip\n* Take [n += 100, once]\n* Stay [n += 0]\n* Leave -> END\n:: snip\n[notes add seen]\nnotes: {notes}';
  const r = play(src, [0, 1, 1]);
  ok('tags parsed', r.game.passages.a.tags.join() === 'hub,x');
  ok('enter+once ran once on arrival', r.log[0] === 'n=11', r.log);
  ok('snippet ran and list updated', r.log[1] === 'notes: seen', r.log);
  ok('stay-in-place does not rerun [enter]/[once]', r.log.filter(l => l === 'n=111').length >= 1 && !r.log.some(l => l === 'n=112'), r.log);
  ok('once-choice hidden after use', r.lastChoices.indexOf('Take') < 0, r.lastChoices);
  ok('snippet with choices is a lint error', lintMsgs('@format 3\n:: a\n>> s\n-> END\n:: s\n* nope -> a').some(m => /can't contain choices/.test(m)));
  ok('calling missing snippet is a lint error', lintMsgs('@format 3\n:: a\n>> nowhere\n-> END').some(m => /missing passage/.test(m)));
}

console.log('\n9. errors surface instead of being swallowed');
{
  ok('bad @set expression', lintMsgs('@format 3\n@set x = 1 +\n:: a\n-> END').some(m => /@set/.test(m)));
  ok('runtime error carries a line number', /line \d+/.test(play('@format 3\n:: a\n* x -> END [boom]', [0]).error || ''));
  ok('@format newer than runtime refused', lintMsgs('@format 9\n:: a\nhi').some(m => /needs tgame format 9/.test(m)));
  ok('directive inside passage warns', lintMsgs('@format 3\n:: a\n@set x = 1\nhi\n-> END').some(m => /inside a passage/.test(m)));
}

console.log('\n10. player: undo / save / load by replay (stub DOM)');
{
  function El(tag){
    this.tag = tag; this.children = []; this.style = {}; this.className = ''; this._html = ''; this.textContent = '';
    this.classList = { add: c => { this.className += ' ' + c; }, remove: c => { this.className = this.className.replace(c, ''); } };
    this.listeners = {}; this.value = '';
    Object.defineProperty(this, 'innerHTML', { get(){ return this._html; }, set(v){ this._html = v; if (v === '') this.children = []; } });
  }
  El.prototype.appendChild = function(c){ this.children.push(c); return c; };
  El.prototype.addEventListener = function(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); };
  El.prototype.removeEventListener = function(){};
  El.prototype.focus = function(){};
  global.document = { createElement: t => new El(t), activeElement: null, createTreeWalker(){ return { nextNode(){ return null; } }; }, createDocumentFragment: () => new El('frag') };
  global.NodeFilter = { SHOW_TEXT: 4 };
  global.localStorage = { _m: {}, getItem(k){ return this._m[k] || null; }, setItem(k, v){ this._m[k] = v; } };
  const out = new El('div'), choices = new El('ul'), form = new El('form'), input = new El('input');
  const P = new api.TgamePlayer({ out, choices, form, input });
  const src = '@format 3\n@title T\n@set hp = random(1,100)\n:: a\nHP {hp}\n* one -> b\n* two -> b\n:: b\nat b\n* three -> c\n:: c\nat c\n-> END';
  const game = api.parse(src);
  P.start(game, { skipEffects: true, hash: api.hashStr(src) });
  const hp0 = P.interp.vars.hp;
  P.pick(0); P.pick(0);
  ok('reached end', P.ended);
  ok('history recorded', P.history.length === 2);
  P.undo();
  ok('undo returns to the choice point', !P.ended && P.pending && P.pending.passage === 'b', P.pending && P.pending.passage);
  ok('undo keeps the same random seed (hp unchanged)', P.interp.vars.hp === hp0);
  P.saveSlot();
  const seedBefore = P.interp.seed;
  P.start(game, { skipEffects: true, hash: api.hashStr(src) });
  ok('fresh start differs in position', P.pending.passage === 'a');
  P.loadSlot();
  ok('load restores position and seed', P.pending && P.pending.passage === 'b' && P.interp.seed === seedBefore);
  ok('typed "undo" command', (P.submit('undo'), P.pending && P.pending.passage === 'a'));
  P.submit('two');
  ok('typed label picks the choice', P.pending && P.pending.passage === 'b');
}

console.log('\n11. every shipped example parses and lints clean');
{
  const src = fs.readFileSync(path.join(dir, 'examples_section.js'), 'utf8');
  const f = new Function('return (function(){' + src.replace(/function loadExample[\s\S]*$/, '') + '; return EXAMPLES; })()');
  const EX = f();
  Object.keys(EX).forEach(k => {
    const msgs = lintMsgs(EX[k].source);
    ok('example "' + k + '" lints clean', msgs.length === 0, msgs);
  });
  const t = fs.readFileSync(path.join(dir, 'template.js'), 'utf8');
  const tpl = new Function(t + '; return TEMPLATE_SOURCE;')();
  ok('template lints clean', lintMsgs(tpl).length === 0, lintMsgs(tpl));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
