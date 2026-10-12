// Generates tests/conformance.json for the Python port from the reference JavaScript runtime.
// Usage: node gen_conformance.js [outfile]
const fs = require('fs'), path = require('path');
const dir = __dirname;
const rt = fs.readFileSync(path.join(dir, 'runtime.js'), 'utf8');
const lt = fs.readFileSync(path.join(dir, 'lint.js'), 'utf8');
const api = new Function(rt + '\n' + lt + '\nreturn {parse,lint,Interp,matchChoice};')();

const exSrc = fs.readFileSync(path.join(dir, 'examples_section.js'), 'utf8').replace(/function loadExample[\s\S]*$/, '');
const EXAMPLES = new Function('return (function(){' + exSrc + '; return EXAMPLES; })()')();
const TEMPLATE = new Function(fs.readFileSync(path.join(dir, 'template.js'), 'utf8') + '; return TEMPLATE_SOURCE;')();

const sources = [];
Object.keys(EXAMPLES).forEach(k => sources.push({ name: 'example:' + k, source: EXAMPLES[k].source }));
sources.push({ name: 'template', source: TEMPLATE });

const extra = {
  arithmetic: [
    '@format 3',
    '@set a = 0.1 + 0.2', '@set b = 7 / 2', '@set c = 7 % 3', '@set d = -7 % 3', '@set e = "1" == 1',
    '@set f = 10 / 0', '@set g = 0 / 0', '@set h = 1 / 3', '@set big = 2 * 100000000000',
    '@set s = "ab" + 1 + 2', '@set t = 1 + 2 + "x"', '@set u = 5 > "4"', '@set v = "b" > "a"', '@set w = true + 1',
    '@set x = 0.000001 * 0.5', '@set y = 123456789 * 987654321', '@set z = 1 / 7 * 7',
    ':: a', '{a}|{b}|{c}|{d}|{e}|{f}|{g}|{h}|{big}|{s}|{t}|{u}|{v}|{w}|{x}|{y}|{z}', '-> END'].join('\n'),
  effects: [
    '@format 3', '@set n = 5', '@set s = "a"', '@list tags',
    ':: a', '[n += 2, n *= 3, n -= 1, n /= 4, n %= 3]', '[s += "b", s += 1]', '[n++]', '[n--]', '[n--]',
    '[tags add one, tags add One, tags add two, tags remove ONE]', '[get Lamp, get lamp, get key]', '[drop LAMP]',
    'n={n} s={s} tags={tags} inv={inventory} count={count tags}',
    '{has key | key | nokey} {has lamp | lamp | nolamp} {tags has TWO | two | notwo}',
    '-> END'].join('\n'),
  random: [
    '@format 3', '@set r0 = random(1, 6)', '@set r1 = random(-5, 5)', '@set r2 = random(1, 1000000)',
    ':: a', '[x = random(1, 6)]', '{r0} {r1} {r2} {x}', '* again -> a', '* more [y = random(0, 1)]', '* end -> END'].join('\n'),
  unicode: [
    '@format 3', '@set puntos = 2', '@set ñandú = "sí"', '@start inicio',
    ':: inicio #ñ', '{puntos} puntos y {ñandú}', '* Ir al jardín | ir, jardín -> jardín', ':: jardín', 'Un jardín.', '-> END'].join('\n'),
  layout: [
    '@format 3',
    ':: a', 'line one', 'line two', '', 'next para', 'hard\\', 'break', '', '```', '  art {x}', '    more', '```', 'done', '* go -> b',
    ':: b', '\\if literal', '\\end', '\\// slash', 'see http://x // y', 'a \\* b \\{c\\} d', '*it* and **bold**', '-> END'].join('\n'),
  legacy: ['@format 2', ':: a', 'one', 'two', '', 'three', '-> END'].join('\n'),
  conditions: [
    '@format 3', '@set score = 3', '@set name = "Ada"',
    ':: a',
    'if not has lamp and score > 1:', 'A', 'else:', 'B', 'end',
    'if score == 3 and name == "Ada" or false:', 'C', 'end',
    'if not (score > 5 or score < 0):', 'D', 'end',
    '{if score > 2}E{if score > 100}x{else}F{end}G{else}H{end}',
    '{score > 2 | big | small} {score | truthy | falsy} {name == "Bob" | bob}',
    'if visited a:', 'V', 'end', 'if visits == 1:', 'first', 'end',
    '-> END'].join('\n'),
  snippets: [
    '@format 3', '@set n = 0', '@list notes',
    ':: a #hub', '[enter n += 1]', '[once n += 10]', 'n={n}', '>> sn', '* Take [n += 100, once]', '* Stay [n += 0]', '* Leave -> END',
    ':: sn', '[notes add seen]', 'notes: {notes}'].join('\n'),
  typed: [
    '@format 3', ':: a', '? Name? [name:text] -> b', ':: b', '? Age? [age:number]', '? Anything? [x]', 'You are {name}, {age}, {x}.', '-> END'].join('\n'),
  errors: [
    '@format 3', '@set bad = 1 +', ':: a', 'if x:', '* x [wave] -> missing', '* y -> END [n +=]', '~bogus', '{if a}unclosed',
    '>> nowhere', '-> b', ':: b', '* c -> a', ':: a', 'dup', ':: lonely', 'never reached', '-> END'].join('\n'),
  linthints: ['@format 3', '@set Score = 0', ':: a', '{score} {Score}', '[nope = 1]', 'if visited gone:', 'x', 'end', '-> END'].join('\n'),
  noformat: [':: a', 'hi', '-> END'].join('\n'),
  badnames: ['@format 3', ':: x" onmouseover="y', 'hi', ':: end', 'hi', ':: ok #tag stray', 'hi'].join('\n'),
  newer: ['@format 9', ':: a', 'hi'].join('\n'),
};
Object.keys(extra).forEach(k => sources.push({ name: 'extra:' + k, source: extra[k] }));

// ---- helpers
const norm = v => (typeof v === 'number' && !isFinite(v)) ? String(v) : v;
const normVars = o => { const r = {}; Object.keys(o).sort().forEach(k => r[k] = norm(o[k])); return r; };
const lintOf = src => api.lint(api.parse(src)).map(p => [p.n, p.sev, p.msg]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
const ANSWERS = ['Ada', '42', 'abc', '-3.5', '7', 'x y'];

function play(source, seed, pick){
  const game = api.parse(source);
  const hasErr = api.lint(game).some(p => p.sev === 'error');
  const res = { inputs: [], lines: [], ended: false, error: null, waiting: null, vars: {}, lists: {}, seed: 0 };
  if (hasErr) { res.error = 'has errors'; return res; }
  const it = new api.Interp(game, { skipEffects: true, seed: seed });
  res.seed = it.seed;
  const gen = it.run();
  let r = gen.next(), n = 0, ai = 0;
  for (let guard = 0; guard < 400 && !r.done; guard++){
    const v = r.value;
    if (v.type === 'text') { res.lines.push(v.text); r = gen.next(); continue; }
    if (v.type === 'pause') { r = gen.next(); continue; }
    if (v.type === 'end') { res.ended = true; break; }
    if (v.type === 'error') { res.error = v.text; break; }
    if (v.type === 'input') { const a = ANSWERS[ai++ % ANSWERS.length]; res.inputs.push(a); r = gen.next(a); continue; }
    if (v.type === 'choice') {
      if (n++ >= pick.steps) { res.waiting = 'choice'; break; }
      const i = pick.next(v.choices.length);
      res.inputs.push(i); r = gen.next(i); continue;
    }
  }
  res.vars = normVars(it.vars);
  Object.keys(it.lists).sort().forEach(k => res.lists[k] = it.lists[k].slice());
  return res;
}
function lcg(seed){ let s = seed >>> 0; return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) % n; }; }

const cases = [];
sources.forEach(({ name, source }) => {
  const lint = lintOf(source);
  const runs = [];
  if (!lint.some(p => p[1] === 'error')) {
    [1, 2, 3, 42, 99999, -5].forEach((seed, si) => {
      const rnd = lcg(1000 + si);
      runs.push(Object.assign({ seedIn: seed }, play(source, seed, { steps: 25, next: rnd })));
    });
  }
  cases.push({ name, source, lint, runs });
});

// typed-input matching (JS is the reference for the matcher too)
const matcher = [];
const mk = (label, aliases) => ({ label, aliases: aliases || [] });
const sets = [
  [mk('Look at the lamp'), mk('Take the lamp', ['get lamp', 'grab lamp']), mk('Open the door', ['go east'])],
  [mk('Écouter'), mk('Ouvrir la porte')],
  [mk('Go north'), mk('Go south'), mk('Wait')],
];
const inputs = ['open the door', 'grab lamp', 'take lamp', 'door', 'lamp', '2', '9', '0', 'dance', '', '  ', 'east', 'go', 'go north', 'écouter', 'ECOUTER', 'the lamp', 'a door', 'take the', 'wait'];
sets.forEach((choices, si) => inputs.forEach(text => {
  const m = api.matchChoice(text, choices, ['the', 'a', 'an']);
  matcher.push({ set: si, choices, text, result: m.index !== undefined ? ['index', m.index] : m.ambiguous ? ['ambiguous', m.ambiguous] : ['none', null] });
}));

const out = process.argv[2] || path.join(dir, '..', 'tgame-py', 'tests', 'conformance.json');
fs.writeFileSync(out, JSON.stringify({ generated_by: 'runtime.js', cases, matcher }, null, 1));
const nRuns = cases.reduce((a, c) => a + c.runs.length, 0);
console.log('wrote ' + out + ': ' + cases.length + ' sources, ' + nRuns + ' recorded runs, ' + matcher.length + ' matcher cases');
