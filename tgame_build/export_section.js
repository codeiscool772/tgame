/* ═══════════════════════════════════════════════════════════════════
   STANDALONE EXPORT
   The exported page embeds the runtime verbatim (the <script id="tgame-runtime">
   block above), so it is always byte-for-byte the engine the IDE tested.
   ═══════════════════════════════════════════════════════════════════ */
function buildStandalone(source){
  const game = parse(source);
  const title = game.meta.title || 'tgame';
  const runtime = document.getElementById('tgame-runtime').textContent.replace(/<\/script/gi, '<\\/script');
  const srcLit = JSON.stringify(source)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const boot =
    'var SOURCE = ' + srcLit + ';\n' +
    '(function(){\n' +
    '  var game = parse(SOURCE);\n' +
    '  var player = new TgamePlayer({\n' +
    '    out: document.getElementById("out"),\n' +
    '    choices: document.getElementById("choices"),\n' +
    '    form: document.getElementById("form"),\n' +
    '    input: document.getElementById("cmd"),\n' +
    '    scroll: function(){ window.scrollTo(0, document.body.scrollHeight); }\n' +
    '  });\n' +
    '  document.title = game.meta.title || "tgame";\n' +
    '  player.start(game, { hash: ' + JSON.stringify(hashStr(source)) + ' });\n' +
    '})();\n';

  return '<!doctype html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>' + esc(title) + '</title>\n' +
'<style>\n' +
'html,body{margin:0;background:#1e1e1e;color:#d4d4d4;\n' +
'  font:15px/1.75 ui-monospace,Menlo,Monaco,Consolas,monospace}\n' +
'body{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 6rem}\n' +
'#out p{margin:0 0 .85em;white-space:pre-wrap}\n' +
'#out pre.pre{margin:0 0 .85em;white-space:pre;overflow-x:auto;font:inherit;line-height:1.3}\n' +
'#out p.echo{color:#9cdcfe;opacity:.6;margin-bottom:.35em}\n' +
'#out p.err{color:#f48771}\n' +
'#out p.sys{color:#6a9955;font-style:italic}\n' +
'#out p.end{color:#ce9178;font-style:italic;text-align:center}\n' +
'#out p.prompt{color:#d99058;font-style:italic}\n' +
'#out em{color:#9cdcfe;font-style:italic}\n' +
'#out strong{color:#e7e7e7;font-weight:600}\n' +
'#choices{list-style:none;padding:0;margin:.8em 0 0}\n' +
'#choices button{background:none;border:0;color:#d99058;font:inherit;\n' +
'  cursor:pointer;padding:.2em 0;text-align:left;display:flex;gap:.8em;width:100%}\n' +
'#choices button:hover,#choices button:focus-visible{color:#e6a56f;text-decoration:underline}\n' +
'#choices .num{color:#8a8a8a}\n' +
'#form{margin-top:1.6em}\n' +
'#cmd{width:100%;box-sizing:border-box;background:#3c3c3c;border:1px solid #3c3c3c;color:#e7e7e7;\n' +
'  font:inherit;padding:.55em .75em;border-radius:3px;outline:0}\n' +
'#cmd:focus{border-color:#d99058}\n' +
'#form.awaiting #cmd{border-color:#d99058;box-shadow:0 0 0 1px #d99058}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<main id="out" role="log" aria-live="polite" aria-label="Story"></main>\n' +
'<ul id="choices" aria-label="Choices"></ul>\n' +
'<form id="form"><input id="cmd" aria-label="Command" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="type a command…"></form>\n' +
'<script>\n' + runtime + '\n' + boot + '<\/script>\n' +
'</body>\n' +
'</html>';
}

function exportHtml(){
  const game = parse(currentText);
  const errs = lint(game).filter(function(p){ return p.sev === 'error'; });
  if (errs.length && !confirm(errs.length + ' error(s) found. Export anyway?')) return;
  const html = buildStandalone(currentText);
  const base = (fileName || 'game.tgame').replace(/\.tgame$/i, '');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '.html';
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 500);
}

