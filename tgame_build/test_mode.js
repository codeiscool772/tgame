const fs = require('fs'), path = require('path');
const CodeMirror = require('codemirror/addon/runmode/runmode.node.js');
global.CodeMirror = CodeMirror;
new Function('CodeMirror', fs.readFileSync(path.join(__dirname, 'cm_mode.js'), 'utf8'))(CodeMirror);

function tokens(src){
  const out = [];
  CodeMirror.runMode(src, 'tgame', (text, style) => { if (text.trim() || style) out.push([text, style]); });
  return out;
}
let bad = 0;
const chk = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x))); if (!c) bad++; };
const styleOf = (toks, text) => (toks.find(t => t[0] === text) || [])[1];

let t = tokens('You see no way out and not much else, or get lost.');
chk('prose words (no/and/not/or/get) are not highlighted', t.every(x => !x[1]), t);

t = tokens('see http://x.y // not a comment');
chk('// mid-line is not a comment', t.every(x => x[1] !== 'comment'), t);

t = tokens('// real comment');
chk('line-start // is a comment', t[0][1] === 'comment', t);

t = tokens('if has lamp and score > 5:');
chk('condition keywords highlighted', styleOf(t, 'has') === 'keyword' && styleOf(t, 'and') === 'keyword' && styleOf(t, 'if') === 'keyword', t);

t = tokens('* Take the lamp | grab lamp -> hall [get lamp, once]');
chk('choice: arrow, alias bar, effects', t.some(x => x[0] === '->' && x[1] === 'keyword') && t.some(x => x[1] === 'meta'), t);

t = tokens(':: entrance #outdoors');
chk('passage name and tag', styleOf(t, 'entrance') === 'def' && styleOf(t, '#outdoors') === 'meta', t);

t = tokens('```\n  art and or no\n```\nafter and');
chk('fenced block is literal, then prose resumes unstyled', t.filter(x => x[1] === 'string').length >= 1 && t[t.length - 1][1] === null, t);

t = tokens('\\if this is prose:');
chk('leading backslash line is narration', !t.some(x => x[1] === 'keyword'), t);

t = tokens('[get lamp, score += 5]');
chk('effect line', styleOf(t, 'get') === 'keyword', t);

t = tokens('Hello {name}, *careful*.');
chk('inline var and italics', styleOf(t, '{name}') === 'variable-2' && styleOf(t, '*careful*') === 'em', t);

console.log(bad ? bad + ' problems' : 'highlighter ok');
process.exit(bad ? 1 : 0);
