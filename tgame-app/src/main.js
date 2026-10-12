'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, userArgs } = require('./args');

const first = parseArgs(userArgs(process.argv, process.defaultApp), process.cwd());
const SMOKE = first.smoke;                       // headless self-test, see test/smoke.js
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tgame-smoke-')));

const FILTERS = [
  { name: 'tgame story', extensions: ['tgame'] },
  { name: 'Text', extensions: ['txt'] },
  { name: 'All files', extensions: ['*'] },
];

/* ---------------------------------------------------------------- state */
const wins = new Map();                          // webContents.id -> record

function iconFor(mode) {
  const name = mode === 'ide' ? 'ide.ico' : 'lite.ico';
  const packaged = path.join(process.resourcesPath || '', name);
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', 'build', name);
}

function readStory(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { path: file, name: path.basename(file), text };
  } catch (e) {
    return { path: file, name: path.basename(file), error: e.code === 'ENOENT' ? 'File not found' : e.message };
  }
}

/* ---------------------------------------------------------------- recent files */
function recentPath() { return path.join(app.getPath('userData'), 'recent.json'); }
function loadRecent() {
  try { return JSON.parse(fs.readFileSync(recentPath(), 'utf8')).filter(p => fs.existsSync(p)); }
  catch (e) { return []; }
}
function addRecent(p) {
  if (!p) return;
  const list = [p].concat(loadRecent().filter(x => x.toLowerCase() !== p.toLowerCase())).slice(0, 10);
  try { fs.writeFileSync(recentPath(), JSON.stringify(list)); } catch (e) { /* not fatal */ }
  try { app.addRecentDocument(p); } catch (e) { /* only works once registered as a file handler */ }
}

/* ---------------------------------------------------------------- windows */
function makeWindow(mode, extra) {
  const win = new BrowserWindow(Object.assign({
    show: !SMOKE,
    backgroundColor: '#1e1e1e',
    icon: iconFor(mode),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  }, extra));
  const id = win.webContents.id;
  const rec = { win, mode, path: null, dirty: false, forceClose: false, startup: null, watching: null };
  wins.set(id, rec);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')))
      win.webContents.toggleDevTools();
  });
  win.on('closed', () => { stopWatch(rec); wins.delete(id); });
  return rec;
}

function stopWatch(rec) {
  if (rec.watching) { fs.unwatchFile(rec.watching); rec.watching = null; }
}

function findWindow(mode, file) {
  if (!file) return null;
  const want = file.toLowerCase();
  for (const rec of wins.values())
    if (rec.mode === mode && rec.path && rec.path.toLowerCase() === want && !rec.win.isDestroyed()) return rec;
  return null;
}

function focus(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openLite(a) {
  if (a.file) {
    const existing = findWindow('lite', a.file);
    if (existing) { focus(existing.win); existing.win.webContents.send('host:command', 'reload'); return existing; }
  }
  const rec = makeWindow('lite', { width: 920, height: 760, minWidth: 420, minHeight: 360, title: 'tgame Lite' });
  if (a.file) { rec.startup = readStory(a.file); rec.path = a.file; addRecent(a.file); }
  else if (a.source != null) rec.startup = { path: null, name: a.name || 'untitled.tgame', text: a.source };
  rec.win.setMenu(buildLiteMenu(rec));
  rec.win.loadFile(path.join(__dirname, '..', 'renderer', 'lite', 'lite.html'));
  smoke(rec);
  return rec;
}

function openIde(a) {
  if (a.file) {
    const existing = findWindow('ide', a.file);
    if (existing) {
      focus(existing.win);
      if (a.line) existing.win.webContents.send('host:command', 'goto-line', a.line);
      return existing;
    }
  }
  const rec = makeWindow('ide', { width: 1400, height: 900, minWidth: 760, minHeight: 520, title: 'tgame IDE', autoHideMenuBar: true });
  if (a.file) { rec.startup = Object.assign(readStory(a.file), { line: a.line || null }); rec.path = a.file; addRecent(a.file); }
  rec.win.setMenu(null);

  rec.win.on('close', e => {
    if (rec.forceClose || !rec.dirty) return;
    e.preventDefault();
    const name = rec.path ? path.basename(rec.path) : 'this file';
    const choice = dialog.showMessageBoxSync(rec.win, {
      type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: 'tgame IDE', message: 'Save changes to ' + name + '?',
    });
    if (choice === 0) rec.win.webContents.send('host:command', 'save-and-close');
    else if (choice === 1) { rec.forceClose = true; rec.win.close(); }
  });
  rec.win.loadFile(path.join(__dirname, '..', 'renderer', 'ide', 'index.html'));
  smoke(rec);
  return rec;
}

function handleArgs(a) {
  return a.mode === 'ide' ? openIde(a) : openLite(a);
}

function buildLiteMenu(rec) {
  const send = (cmd) => () => rec.win.webContents.send('host:command', cmd);
  return Menu.buildFromTemplate([
    { label: '&File', submenu: [
      { label: '&Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: '&Edit in tgame IDE', accelerator: 'CmdOrCtrl+E', click: send('edit') },
      { type: 'separator' },
      { role: 'close', label: '&Close' },
      { role: 'quit', label: '&Quit' },
    ] },
    { label: '&Game', submenu: [
      { label: '&Restart', accelerator: 'F5', click: send('restart') },
      { label: '&Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { type: 'separator' },
      { label: '&Save game', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: '&Load game', accelerator: 'CmdOrCtrl+L', click: send('load') },
    ] },
    { label: '&View', submenu: [
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: '&Help', submenu: [
      { label: 'Check for &updates…', click: () => checkForUpdates(rec.win) },
      { label: 'About tgame', click: () => dialog.showMessageBox(rec.win, {
        type: 'info', title: 'tgame', message: 'tgame ' + app.getVersion(),
        detail: 'Lite plays .tgame stories. The IDE edits them.\nElectron ' + process.versions.electron + ' · format 3' }) },
    ] },
  ]);
}

/* ---------------------------------------------------------------- IPC */
const recOf = (e) => wins.get(e.sender.id);

ipcMain.on('host:version', e => { e.returnValue = app.getVersion(); });
ipcMain.handle('host:startup', e => { const r = recOf(e); return r ? r.startup : null; });

ipcMain.handle('host:open-dialog', async e => {
  const r = recOf(e);
  const res = await dialog.showOpenDialog(r.win, { filters: FILTERS, properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  const story = readStory(res.filePaths[0]);
  if (!story.error) { r.path = story.path; addRecent(story.path); }
  return story;
});

ipcMain.handle('host:read', (e, p) => readStory(p));

ipcMain.handle('host:write', (e, p, text) => {
  fs.writeFileSync(p, String(text), 'utf8');
  const r = recOf(e);
  if (r) r.path = p;
  addRecent(p);
  return { path: p, name: path.basename(p) };
});

ipcMain.handle('host:write-as', async (e, opts) => {
  const r = recOf(e);
  const res = await dialog.showSaveDialog(r.win, {
    defaultPath: opts.defaultPath || opts.defaultName || 'untitled.tgame',
    filters: opts.filters || FILTERS,
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, String(opts.text), 'utf8');
  if (opts.track !== false) { r.path = res.filePath; addRecent(res.filePath); }
  return { path: res.filePath, name: path.basename(res.filePath) };
});

ipcMain.handle('host:recent', () => loadRecent());
ipcMain.handle('host:open-ide', (e, o) => { openIde({ file: o && o.path, line: o && o.line }); return true; });
ipcMain.handle('host:open-lite', (e, o) => { openLite({ file: o && o.path, source: o && o.source, name: o && o.name }); return true; });

ipcMain.on('host:set-dirty', (e, b) => { const r = recOf(e); if (r) r.dirty = !!b; });
ipcMain.on('host:set-path', (e, p) => { const r = recOf(e); if (r) { r.path = p || null; if (p) addRecent(p); } });
ipcMain.on('host:close-now', e => { const r = recOf(e); if (r) { r.forceClose = true; r.win.close(); } });
ipcMain.on('host:watch', (e, p) => {
  const r = recOf(e);
  if (!r) return;
  stopWatch(r);
  if (!p) return;
  r.watching = p;
  fs.watchFile(p, { interval: 400 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs && !r.win.isDestroyed()) r.win.webContents.send('host:file-changed', p);
  });
});

/* ---------------------------------------------------------------- headless self-test (npm test) */
function smoke(r) {
  if (!SMOKE) return;
  const finish = (obj, code) => { console.log('SMOKE_RESULT ' + JSON.stringify(obj)); app.exit(code); };
  setTimeout(() => finish({ error: 'timeout' }, 3), 20000);
  r.win.webContents.on('did-fail-load', (e, code, desc) => finish({ error: 'load failed: ' + desc }, 2));
  r.win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.log('RENDERER_ERROR ' + message); });
  r.win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise(res => setTimeout(res, 900));
      if (SMOKE === 'lite-reload' && r.path) { fs.appendFileSync(r.path, '\n:: extra\nadded while open\n'); await new Promise(res => setTimeout(res, 1800)); }
      if (SMOKE === 'ide-save') {
        await r.win.webContents.executeJavaScript("cm.setValue(cm.getValue() + '\\n// saved from the ide'); hostSave(false);");
        await new Promise(res => setTimeout(res, 800));
      }
      const script = r.mode === 'ide'
        ? "({hostApp:!!window.tgameHost,title:document.title,cm:typeof CodeMirror,editor:(typeof cm!=='undefined'&&cm)?cm.getValue().slice(0,80):null,problems:typeof lastProblems!=='undefined'?lastProblems.length:null,play:document.getElementById('out').textContent.slice(0,120),dirty:document.getElementById('file-tab').classList.contains('dirty'),line:(typeof cm!=='undefined'&&cm)?cm.getCursor().line+1:null})"
        : "({hostApp:!!window.tgameHost,title:document.title,bar:document.getElementById('title').textContent,out:document.getElementById('out').textContent.slice(0,300),choices:document.querySelectorAll('#choices button').length,home:!document.getElementById('home').hidden,problems:document.getElementById('problems').hidden?0:document.querySelectorAll('#problems li').length})";
      const result = await r.win.webContents.executeJavaScript(script);
      if (process.env.TGAME_SHOT) {                       // optional: save a screenshot of the window
        const img = await r.win.webContents.capturePage();
        fs.writeFileSync(process.env.TGAME_SHOT, img.toPNG());
      }
      finish(result, 0);
    } catch (err) { finish({ error: String(err) }, 4); }
  });
}

/* ---------------------------------------------------------------- updates (GitHub Releases) */
/* Packaged builds carry resources/app-update.yml, generated from "build.publish" in package.json,
   so the app knows which repo to ask. A check downloads latest.yml from the newest release; if it
   is newer than this version the installer is fetched (differentially) and run on quit or on request. */
let autoUpdater = null;
let manualCheckWin = null;

function getUpdater() {
  if (autoUpdater) return autoUpdater;
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info() {}, warn() {}, debug() {}, error: (m) => console.error('[updater]', m) };

  const say = (win, opts) => dialog.showMessageBox(win || BrowserWindow.getFocusedWindow() || undefined, Object.assign({ type: 'info', title: 'tgame' }, opts));
  autoUpdater.on('update-available', (info) => {
    if (manualCheckWin) say(manualCheckWin, { message: 'tgame ' + info.version + ' is available.', detail: 'It is downloading now; you will be asked to restart when it is ready.' });
    manualCheckWin = null;
  });
  autoUpdater.on('update-not-available', () => {
    if (manualCheckWin) say(manualCheckWin, { message: 'You are up to date.', detail: 'tgame ' + app.getVersion() });
    manualCheckWin = null;
  });
  autoUpdater.on('error', (err) => {
    if (manualCheckWin) say(manualCheckWin, { type: 'warning', message: 'Could not check for updates.', detail: String((err && err.message) || err).split('\n')[0] });
    manualCheckWin = null;
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const dirty = Array.from(wins.values()).some(r => r.dirty);
    const res = await say(null, {
      message: 'tgame ' + info.version + ' is ready to install.',
      detail: dirty ? 'You have unsaved changes in the IDE. Save them first; the update will also install the next time you quit.'
                    : 'tgame will restart to finish the update.',
      buttons: dirty ? ['OK'] : ['Restart and update', 'Later'], defaultId: 0, cancelId: dirty ? 0 : 1,
    });
    if (!dirty && res.response === 0) {
      for (const r of wins.values()) r.forceClose = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
  return autoUpdater;
}

function checkForUpdates(win) {
  if (!app.isPackaged) {
    if (win) dialog.showMessageBox(win, { type: 'info', title: 'tgame', message: 'Updates are checked in the installed app.', detail: 'This is a development run.' });
    return;
  }
  manualCheckWin = win || null;
  getUpdater().checkForUpdates().catch(() => { /* reported by the 'error' event */ });
}

function scheduleUpdateChecks() {
  if (!app.isPackaged || SMOKE) return;
  const quiet = () => getUpdater().checkForUpdates().catch(() => { /* offline is fine */ });
  setTimeout(quiet, 8000);
  setInterval(quiet, 6 * 60 * 60 * 1000);
}

ipcMain.handle('host:check-updates', (e) => { const r = recOf(e); checkForUpdates(r && r.win); return true; });

/* smoke test: ask the real GitHub repo about a pretend-old version (needs network) */
async function updateSmoke() {
  const finish = (obj, code) => { console.log('SMOKE_RESULT ' + JSON.stringify(obj)); app.exit(code); };
  setTimeout(() => finish({ error: 'timeout' }, 3), 30000);
  try {
    const pub = require('../package.json').build.publish[0];
    const cfg = path.join(app.getPath('userData'), 'dev-app-update.yml');
    fs.writeFileSync(cfg, 'provider: github\nowner: ' + pub.owner + '\nrepo: ' + pub.repo + '\n');
    const u = require('electron-updater').autoUpdater;
    u.forceDevUpdateConfig = true;
    u.updateConfigPath = cfg;
    u.autoDownload = false;
    u.currentVersion = new (require('semver').SemVer)('0.0.1');
    const r = await u.checkForUpdates();
    finish({ repo: pub.owner + '/' + pub.repo, available: r.isUpdateAvailable, version: r.updateInfo.version,
             files: r.updateInfo.files.map(f => f.url) }, 0);
  } catch (err) { finish({ error: String(err && err.message || err).split('\n')[0] }, 4); }
}

/* ---------------------------------------------------------------- lifecycle */
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd) => handleArgs(parseArgs(userArgs(argv, process.defaultApp), cwd)));
  app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openLite({ file: p }); else first.file = p; });  // macOS
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    if (SMOKE === 'update') return updateSmoke();
    handleArgs(first);
    scheduleUpdateChecks();
  });
}
