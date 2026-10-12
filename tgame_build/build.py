import re, sys, pathlib

B = pathlib.Path(__file__).resolve().parent
SRC = B / 'base-ide.html'              # the original single-file IDE the parts are patched into
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else B.parent / 'Tgame-IDE.html'

def rd(name): return (B / name).read_text(encoding='utf-8')

html = SRC.read_text(encoding='utf-8')

def must_replace(s, old, new, count=1):
    if s.count(old) != count:
        raise SystemExit('expected %d match(es) for: %r (found %d)' % (count, old[:70], s.count(old)))
    return s.replace(old, new)

# ---------- split page / ide script ----------
open_tag = '<script>\n"use strict";\n'
i0 = html.index(open_tag)
i1 = html.index('</script>', i0)
head = html[:i0]
ide = html[i0 + len('<script>\n'):i1]
tail = html[i1 + len('</script>'):]

# ---------- IDE script surgery ----------
def banner(s, title):
    m = re.search(r'/\* ═+\n   ' + re.escape(title) + r'(?=\n)', s)
    if not m: raise SystemExit('banner not found: ' + title)
    return m.start()

def swap(s, t_from, t_to, new):
    a, b = banner(s, t_from), banner(s, t_to)
    return s[:a] + new + s[b:]

ide = swap(ide, 'ESCAPES', 'STATIC HIGHLIGHTER', rd('lint.js'))
ide = swap(ide, 'CODEMIRROR — tgame simple mode', 'STATE', rd('cm_mode.js'))
ide = swap(ide, 'PLAY — output + typewriter', 'SIDEBAR', rd('play_section.js'))
ide = swap(ide, 'STANDALONE EXPORT', 'EXAMPLES', rd('export_section.js'))
ide = swap(ide, 'EXAMPLES', 'MODALS / TUTORIAL / PALETTE', rd('examples_section.js'))

a = ide.index('function buildEdges(game){')
b = ide.index('function renderSidebar(game, problems){')
ide = ide[:a] + rd('graph_section.js') + ide[b:]

ide = must_replace(ide, "'<span class=\"meta\">' + p.n + '</span>'",
  "'<span class=\"meta\">' + (p.tags && p.tags.length ? esc(p.tags.map(function(t){ return '#' + t; }).join(' ')) + ' · ' : '') + p.n + '</span>'")

old_esc = """function esc(s){
  return String(s).replace(/[&<>]/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
  });
}"""
ide = must_replace(ide, old_esc, "function esc(s){ return escHtml(s); }")

a = ide.index('const TUTORIAL = [')
b = ide.index('let tutIndex = 0;')
ide = ide[:a] + rd('tutorial.js') + ide[b:]

ide = must_replace(ide, "{ id:'new',",
  "{ id:'undo',     label:'Undo Last Move',           hint:'',            run: function(){ player.undo(); } },\n"
  "  { id:'savegame', label:'Save Game (play slot)',    hint:'',            run: function(){ player.saveSlot(); } },\n"
  "  { id:'loadgame', label:'Load Game (play slot)',    hint:'',            run: function(){ player.loadSlot(); } },\n"
  "  { id:'new',")

a = ide.index('const TEMPLATE_SOURCE = ')
b = ide.index('(function boot(){')
ide = ide[:a] + rd('template.js') + ide[b:]

for dead in ('let awaitingInput   = null;\n', 'let activeTypewriter = null;\n'):
    ide = must_replace(ide, dead, '')

# ---------- page surgery ----------
head = must_replace(head, '<div class="out" id="out"></div>',
  '<div class="out" id="out" role="log" aria-live="polite" aria-label="Story"></div>')
head = must_replace(head, '<input id="cmd" placeholder=', '<input id="cmd" aria-label="Command" placeholder=')
head = must_replace(head, '<button class="icon-btn" id="btn-restart"',
  '<button class="icon-btn" id="btn-undo" title="Undo last move">Undo</button>\n'
  '        <button class="icon-btn" id="btn-save-game" title="Save game">Save</button>\n'
  '        <button class="icon-btn" id="btn-load-game" title="Load saved game">Load</button>\n'
  '        <button class="icon-btn" id="btn-restart"')
head = must_replace(head, '<div class="status-item">tgame 2.0</div>', '<div class="status-item">tgame 3.0</div>')
head = must_replace(head, 'tgame language reference · format 2', 'tgame language reference · format 3')
head = must_replace(head, '.cm-error-line{',
  '.cm-s-default .cm-string-2{color:var(--syn-number)}\n'
  '.cm-s-default .cm-strong{font-weight:600;color:var(--text-bright)}\n'
  '.cm-s-default .cm-em{font-style:italic}\n'
  '.out pre.pre{margin:0 0 .75em;white-space:pre;overflow-x:auto;font:13px/1.3 var(--mono);color:var(--text)}\n'
  '.cm-error-line{')

hs = head.index('<h3>Directives</h3>')
hs = head.rfind('\n', 0, hs) + 1
endmark = 'Close dialogs\n      </p>'
he = head.index(endmark) + len(endmark)
head = head[:hs] + rd('help_body.html').rstrip('\n') + head[he:]

# ---------- assemble ----------
runtime = rd('runtime.js')
if '</script' in runtime.lower():
    raise SystemExit('runtime.js contains </script')
result = (head + '<script id="tgame-runtime">\n' + runtime + '</script>\n\n<script>\n' + ide + '</script>' + tail)

OUT.write_text(result, encoding='utf-8')

leftovers = ['RUNTIME_FNS', 'outPrint(', 'typewriterPrint', 'clearPlay', 'awaitingInput', 'activeTypewriter', 'STANDALONE_BOOT']
for w in leftovers:
    n = result.count(w)
    if n: print('WARNING: %d leftover reference(s) to %s' % (n, w))
print('wrote', OUT, len(result.splitlines()), 'lines')
input("Press Enter to continue...")