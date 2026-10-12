'use strict';
/* Assembles the renderer from the single sources of truth:
     ../tgame_build/runtime.js, lint.js     -> renderer/shared/   (used by Lite)
     ../tgame_build/node_modules/codemirror -> vendor/            (so nothing loads from a CDN)
     ../Tgame-IDE.html                      -> renderer/ide/index.html  (patched for the desktop host)
   Run with:  npm run sync */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const build = path.join(root, '..', 'tgame_build');
const ideSrc = path.join(root, '..', 'Tgame-IDE.html');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function must(text, old, neu, count) {
  const n = text.split(old).length - 1;
  if (n !== (count || 1)) throw new Error('IDE patch failed: expected ' + (count || 1) + ' match(es), found ' + n + ' for: ' + old.slice(0, 80));
  return text.split(old).join(neu);
}

/* shared engine files */
copy(path.join(build, 'runtime.js'), path.join(root, 'renderer', 'shared', 'runtime.js'));
copy(path.join(build, 'lint.js'), path.join(root, 'renderer', 'shared', 'lint.js'));

/* CodeMirror 5, vendored */
const cm = path.join(root, 'node_modules', 'codemirror');
copy(path.join(cm, 'lib', 'codemirror.js'), path.join(root, 'vendor', 'codemirror.js'));
copy(path.join(cm, 'lib', 'codemirror.css'), path.join(root, 'vendor', 'codemirror.css'));
copy(path.join(cm, 'LICENSE'), path.join(root, 'vendor', 'codemirror.LICENSE'));

/* the IDE, patched */
let h = fs.readFileSync(ideSrc, 'utf8').replace(/\r\n/g, '\n');

const cdn = /<link rel="stylesheet"\s*\n?\s*href="https:\/\/cdnjs[^"]*codemirror\.min\.css"[\s\S]*?addon\/mode\/simple\.min\.js"[\s\S]*?<\/script>/;
if (!cdn.test(h)) throw new Error('IDE patch failed: CodeMirror CDN block not found');
h = h.replace(cdn, '<link rel="stylesheet" href="../../vendor/codemirror.css">\n<script src="../../vendor/codemirror.js"></script>');
const csp = '<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; connect-src \'none\'">';
if (h.indexOf('<head>') < 0 || h.indexOf('<head>') > 2000) throw new Error('IDE patch failed: <head> not near the top');
h = h.replace('<head>', function () { return csp; });     // first occurrence only (the export template has another)

/* files: real open / save through the desktop host */
h = must(h, 'function downloadFile(){', 'function downloadFile(){\n  if (window.tgameHost){ hostSave(false); return; }');
h = must(h, "$('file-input').click()", 'openFileDialog()', 2);
h = must(h, "if (cmd && e.key.toLowerCase() === 's'){ e.preventDefault(); downloadFile(); return; }",
  "if (cmd && e.key.toLowerCase() === 's'){ e.preventDefault(); if (e.shiftKey && window.tgameHost) hostSave(true); else downloadFile(); return; }");
h = must(h, "label:'Save As\u2026'", "label:'Save'");
h = must(h, "{ id:'save',",
  "{ id:'saveas',   label:'Save As…',                 hint:'Ctrl+Shift+S', run: function(){ if (window.tgameHost) hostSave(true); else downloadFile(); } },\n" +
  "  { id:'lite',     label:'Play in tgame Lite',       hint:'',            run: function(){ playInLite(); } },\n" +
  "  { id:'updates',  label:'Check for updates…',       hint:'',            run: function(){ if (window.tgameHost) window.tgameHost.checkForUpdates(); } },\n" +
  "  { id:'save',");
h = must(h, "const base = (fileName || 'game.tgame').replace(/\\.tgame$/i, '');",
  "const base = (fileName || 'game.tgame').replace(/\\.tgame$/i, '');\n" +
  "  if (window.tgameHost){ window.tgameHost.writeAs({ defaultName: base + '.html', text: html, track: false, filters: [{ name: 'HTML page', extensions: ['html'] }] }); return; }");

/* dirty tracking, autosave, new file / examples forget the path */
h = must(h, "function markDirty(){ $('file-tab').classList.add('dirty'); }",
  "function markDirty(){ $('file-tab').classList.add('dirty'); if (window.tgameHost) window.tgameHost.setDirty(true); }");
h = must(h, "function clearDirty(){ $('file-tab').classList.remove('dirty'); }",
  "function clearDirty(){ $('file-tab').classList.remove('dirty'); if (window.tgameHost) window.tgameHost.setDirty(false); }");
h = must(h, "saveTimer = setTimeout(function(){\n    try {\n      localStorage.setItem('tgame.source', currentText);",
  "saveTimer = setTimeout(function(){\n    if (window.tgameHost && currentPath) return;      // file-backed: stays dirty until saved to disk\n    try {\n      localStorage.setItem('tgame.source', currentText);");
h = must(h, "  applySource(TEMPLATE_SOURCE);\n  setFileName('untitled.tgame');",
  "  currentPath = null; if (window.tgameHost) window.tgameHost.setPath(null);\n  applySource(TEMPLATE_SOURCE);\n  setFileName('untitled.tgame');");
h = must(h, "  applySource(ex.source);\n  setFileName(key + '.tgame');",
  "  currentPath = null; if (window.tgameHost) window.tgameHost.setPath(null);\n  applySource(ex.source);\n  setFileName(key + '.tgame');");

/* the desktop section itself, placed before the export banner */
const hostSection = fs.readFileSync(path.join(__dirname, 'ide-host.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /\/\* ═+\n   STANDALONE EXPORT/.exec(h);
if (!m) throw new Error('IDE patch failed: export banner not found');
h = h.slice(0, m.index) + hostSection + '\n' + h.slice(m.index);

/* boot: open the file the window was launched with */
h = must(h, '(function boot(){', '(async function boot(){');
h = must(h, '  initEditor();\n  applySource(source);',
  "  let startLine = null;\n" +
  "  if (window.tgameHost){\n" +
  "    try {\n" +
  "      const f = await window.tgameHost.getStartupFile();\n" +
  "      if (f && !f.error){ source = f.text; name = f.name; currentPath = f.path; startLine = f.line; }\n" +
  "      else if (f && f.error){ alert('Could not open ' + f.path + ': ' + f.error); }\n" +
  "    } catch(e){}\n" +
  "    window.tgameHost.onCommand(function(cmd, arg){\n" +
  "      if (cmd === 'save-and-close') hostSave(false).then(function(ok){ if (ok) window.tgameHost.closeNow(); });\n" +
  "      else if (cmd === 'goto-line' && cm){ cm.setCursor({ line: arg - 1, ch: 0 }); cm.scrollIntoView(null, 200); cm.focus(); }\n" +
  "    });\n" +
  "  }\n" +
  "  initEditor();\n  applySource(source);");
h = must(h, '  clearDirty();\n  if (cm) cm.focus();',
  '  clearDirty();\n  if (cm) cm.focus();\n  if (startLine && cm){ cm.setCursor({ line: startLine - 1, ch: 0 }); cm.scrollIntoView(null, 200); }');

fs.mkdirSync(path.join(root, 'renderer', 'ide'), { recursive: true });
h = h.split('tgame studio').join('tgame IDE');          // the desktop app calls it tgame IDE
fs.writeFileSync(path.join(root, 'renderer', 'ide', 'index.html'), h, 'utf8');
console.log('synced: renderer/shared, vendor, renderer/ide/index.html (' + h.length + ' bytes)');
