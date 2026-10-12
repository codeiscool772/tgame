/* ═══════════════════════════════════════════════════════════════════
   DESKTOP APP — real files through the host (only reached inside tgame IDE)
   ═══════════════════════════════════════════════════════════════════ */
let currentPath = null;

async function hostSave(forceDialog){
  const host = window.tgameHost;
  if (!host){ downloadFile(); return false; }
  try {
    let res;
    if (currentPath && !forceDialog) res = await host.write(currentPath, currentText);
    else res = await host.writeAs({ defaultName: fileName || 'untitled.tgame', text: currentText });
    if (!res) return false;                       // dialog cancelled
    currentPath = res.path;
    setFileName(res.name);
    clearDirty();
    return true;
  } catch(e){
    alert('Could not save: ' + e.message);
    return false;
  }
}

async function openFileDialog(){
  const host = window.tgameHost;
  if (!host){ $('file-input').click(); return; }
  if ($('file-tab').classList.contains('dirty') && currentPath && !confirm('Discard unsaved changes?')) return;
  const f = await host.openDialog();
  if (!f) return;
  if (f.error){ alert('Could not open ' + f.path + ': ' + f.error); return; }
  currentPath = f.path;
  applySource(f.text);
  setFileName(f.name);
  scheduleLint();
  runGame();
  clearDirty();
}

function playInLite(){
  if (!window.tgameHost){ alert('Play in tgame Lite is only available in the desktop app.'); return; }
  window.tgameHost.openInLite({ source: currentText, name: fileName });
}

