/* tgame Lite — plays a .tgame. All the engine work is the shared runtime (TgamePlayer);
   this file is only the window around it. */
(function () {
  'use strict';
  const host = window.tgameHost;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  if (!host) { document.body.textContent = 'tgame Lite has to run inside the tgame app.'; return; }

  let current = null;                       // {path, name, text}
  let view = 'home';

  const player = new TgamePlayer({
    out: $('out'), choices: $('choices'), form: $('form'), input: $('cmd'),
    scroll: function () { stage.scrollTop = stage.scrollHeight; },
  });

  /* ------------------------------------------------------------ views */
  function setView(v) {
    view = v;
    ['home', 'problems', 'game'].forEach(function (id) { $(id).hidden = id !== v; });
    ['b-undo', 'b-save', 'b-load', 'b-restart'].forEach(function (id) { $(id).disabled = v !== 'game'; });
    $('b-edit').disabled = !(current && current.path);
    if (v === 'game') $('cmd').focus();
  }
  function setTitle(t) {
    $('title').textContent = t;
    $('title').title = current && current.path ? current.path : '';
    document.title = t === 'tgame Lite' ? t : t + ' — tgame Lite';
  }

  async function showHome() {
    current = null;
    setTitle('tgame Lite');
    setView('home');
    const list = $('recent');
    list.innerHTML = '';
    let recent = [];
    try { recent = await host.recent(); } catch (e) { /* none */ }
    $('recent-wrap').hidden = !recent.length;
    recent.forEach(function (p) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      a.textContent = p.slice(i + 1);
      a.onclick = function () { openPath(p); };
      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = p.slice(0, i);
      li.appendChild(a);
      li.appendChild(dir);
      list.appendChild(li);
    });
  }

  function showProblems(story, problems) {
    setView('problems');
    const errors = problems.filter(function (p) { return p.sev === 'error'; });
    $('problems-title').textContent = errors.length + (errors.length === 1 ? ' error' : ' errors') + ' in ' + story.name;
    const ul = $('problem-list');
    ul.innerHTML = '';
    problems.forEach(function (p) {
      const li = document.createElement('li');
      li.className = 'sev-' + p.sev;
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = p.n ? 'line ' + p.n : '';
      const msg = document.createElement(story.path && p.n ? 'a' : 'span');
      msg.textContent = p.msg;
      if (story.path && p.n) msg.onclick = function () { host.openInIde({ path: story.path, line: p.n }); };
      li.appendChild(ln);
      li.appendChild(msg);
      ul.appendChild(li);
    });
  }

  /* ------------------------------------------------------------ loading */
  function load(story, reloaded) {
    current = story;
    if (story.path) { host.setPath(story.path); host.watch(story.path); }
    if (story.error) {
      setTitle(story.name || 'tgame Lite');
      showProblems(story, [{ sev: 'error', n: 0, msg: story.error }]);
      return;
    }
    let game, problems;
    try { game = parse(story.text); problems = lint(game); }
    catch (e) { setTitle(story.name); showProblems(story, [{ sev: 'error', n: 0, msg: 'Could not read this file: ' + e.message }]); return; }

    setTitle(game.meta.title || story.name.replace(/\.tgame$/i, ''));
    const errors = problems.filter(function (p) { return p.sev === 'error'; });
    if (errors.length) { showProblems(story, problems); return; }
    setView('game');
    player.start(game, { hash: hashStr(story.text) });
    if (reloaded) player.print('— reloaded —', 'sys');
  }

  async function openPath(p) {
    const story = await host.read(p);
    load(story);
  }
  async function openDialog() {
    const story = await host.openDialog();
    if (story) load(story);
  }

  /* reload when the file changes on disk (e.g. saved from the IDE) */
  let reloadTimer = null;
  host.onFileChanged(function (p) {
    if (!current || current.path !== p) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async function () {
      const story = await host.read(p);
      if (story.error || (current && story.text === current.text)) return;
      load(story, true);
    }, 150);
  });

  /* ------------------------------------------------------------ commands (menu, buttons) */
  function edit() {
    if (current && current.path) host.openInIde({ path: current.path });
  }
  function restart() { if (current && !current.error) load(current); }
  async function reload() { if (current && current.path) { load(await host.read(current.path), true); } }

  const commands = {
    open: openDialog,
    edit: edit,
    restart: restart,
    reload: reload,
    undo: function () { if (view === 'game') player.undo(); },
    save: function () { if (view === 'game') player.saveSlot(); },
    load: function () { if (view === 'game') player.loadSlot(); },
  };
  host.onCommand(function (cmd) { if (commands[cmd]) commands[cmd](); });

  $('b-undo').onclick = commands.undo;
  $('b-save').onclick = commands.save;
  $('b-load').onclick = commands.load;
  $('b-restart').onclick = restart;
  $('b-edit').onclick = edit;
  $('h-open').onclick = openDialog;

  /* ------------------------------------------------------------ drag and drop */
  let depth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; $('drop').hidden = false; });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    const p = f && host.pathForFile(f);
    if (p) openPath(p);
  });

  /* ------------------------------------------------------------ go */
  host.getStartupFile().then(function (s) { if (s) load(s); else showHome(); });
})();
