'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('tgameHost', {
  isApp: true,
  platform: process.platform,
  version: ipcRenderer.sendSync('host:version'),

  /* what this window was opened with: {path, name, text, line} | {error} | null */
  getStartupFile: () => invoke('host:startup'),

  openDialog:  ()            => invoke('host:open-dialog'),
  read:        (p)           => invoke('host:read', p),
  write:       (p, text)     => invoke('host:write', p, text),
  writeAs:     (opts)        => invoke('host:write-as', opts),
  recent:      ()            => invoke('host:recent'),

  checkForUpdates: ()        => invoke('host:check-updates'),
  openInIde:   (o)           => invoke('host:open-ide', o),
  openInLite:  (o)           => invoke('host:open-lite', o),

  setDirty:    (b)           => ipcRenderer.send('host:set-dirty', !!b),
  setPath:     (p)           => ipcRenderer.send('host:set-path', p),
  closeNow:    ()            => ipcRenderer.send('host:close-now'),
  watch:       (p)           => ipcRenderer.send('host:watch', p),
  pathForFile: (f)           => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },

  onCommand:     (cb) => ipcRenderer.on('host:command', (_e, cmd, ...rest) => cb(cmd, ...rest)),
  onFileChanged: (cb) => ipcRenderer.on('host:file-changed', (_e, p) => cb(p)),
});
