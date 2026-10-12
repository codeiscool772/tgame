const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = __dirname;
const html = fs.readFileSync(path.join(dir, '..', 'Tgame-IDE.html'), 'utf8');
let bad = 0;
const chk = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); if (!c) bad++; };

// 1. both scripts compile
const scripts = [...html.matchAll(/<script(?: id="tgame-runtime")?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
chk('two inline scripts found (runtime + IDE)', scripts.length === 2, scripts.length);
scripts.forEach((s, i) => { try { new vm.Script(s); chk('script ' + i + ' compiles', true); } catch(e){ chk('script ' + i + ' compiles', false, e.message); } });

// 2. every $('id') and getElementById target exists in the markup
const ide = scripts[1];
const wanted = new Set([...ide.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
const markup = html.slice(0, html.indexOf('<script id="tgame-runtime">'));
const missing = [...wanted].filter(id => !new RegExp('id="' + id + '"').test(markup));
chk('all $("id") targets exist', missing.length === 0, missing);

// 3. every function the IDE calls from the engine exists in the runtime
const rtNames = ['parse','lint','Interp','TgamePlayer','classifyLine','splitChoice','parsePromptLine','hashStr','escHtml','evalExpr'];
try { const d = new Function(scripts[0] + '\nreturn {' + rtNames.filter(n => n !== 'lint').join(',') + '};')(); chk('runtime exports present', Object.values(d).every(v => typeof v !== 'undefined')); } catch(e){ chk('runtime exports present', false, e.message); }
chk('lint() lives in the IDE script', /function lint\(game\)/.test(ide));

// 4. exported standalone page: build it with the real buildStandalone and run it against a stub DOM
const api = new Function(scripts[0] + '\nreturn {parse,hashStr,escHtml,TgamePlayer,Interp};')();
const m = ide.match(/function buildStandalone\(source\)\{[\s\S]*?\r?\n\}\r?\n/);
const build = new Function('parse','hashStr','esc','document', m[0] + '\nreturn buildStandalone;')(api.parse, api.hashStr, api.escHtml, { getElementById: () => ({ textContent: scripts[0] }) });
const src = '@format 3\n@title Export Test\n:: a\nHello </script> world\n* go -> END';
const page = build(src);
chk('standalone has exactly one executable script', (page.match(/<script>/g) || []).length === 1 && (page.match(/<\/script>/g) || []).length === 1);
const inner = page.match(/<script>([\s\S]*)<\/script>/)[1];
try { new vm.Script(inner); chk('standalone script compiles', true); } catch(e){ chk('standalone script compiles', false, e.message); }

const printed = [];
function El(){ this.children = []; this.style = {}; this.classList = { add(){}, remove(){} }; this.value = ''; this._h = ''; Object.defineProperty(this, 'innerHTML', { get(){ return this._h; }, set(v){ this._h = v; if (v === '') this.children = []; } }); }
El.prototype.appendChild = function(c){ this.children.push(c); if (c.tag === 'p' || c.tag === 'pre') printed.push(c.innerHTML || c.textContent); return c; };
El.prototype.addEventListener = function(){}; El.prototype.removeEventListener = function(){}; El.prototype.focus = function(){};
const els = {};
const doc = { getElementById: id => els[id] = els[id] || new El(), createElement: t => { const e = new El(); e.tag = t; return e; }, activeElement: null, title: '', body: { scrollHeight: 0 } };
const sandbox = { document: doc, window: { scrollTo(){} , matchMedia: null }, localStorage: { getItem(){ return null; }, setItem(){} }, setTimeout, setInterval, clearInterval, console, NodeFilter: { SHOW_TEXT: 4 } };
sandbox.window.document = doc;
try { vm.runInNewContext(inner, sandbox); chk('standalone boots and prints the story', printed.some(t => /Hello/.test(t)), printed); chk('</script> in story text cannot break the page', true); }
catch(e){ chk('standalone boots', false, e.stack); }

console.log(bad ? '\n' + bad + ' problems' : '\nall page checks passed');
process.exit(bad ? 1 : 0);
