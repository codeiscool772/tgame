/* ═══════════════════════════════════════════════════════════════════
   PLAY — the IDE hosts the same TgamePlayer that exported games use
   ═══════════════════════════════════════════════════════════════════ */
const player = new TgamePlayer({
  out: outEl, choices: choicesEl, form: cmdForm, input: cmdEl,
  scroll: function(){ outEl.scrollTop = outEl.scrollHeight; },
  onReset: function(){
    currentPassage = null;
    updateBreadcrumbs();
  },
  onStart: function(interp){
    startVarsRef  = Object.assign({}, interp.vars);
    startListsRef = {};
    for (const k in interp.lists) startListsRef[k] = interp.lists[k].slice();
    renderVars(interp);
  },
  onChoice: function(interp, passage){
    currentPassage = passage;
    updateBreadcrumbs();
    highlightInSidebar(passage);
    renderVars(interp);
  },
  onEnd: function(interp){
    currentPassage = null;
    updateBreadcrumbs();
    renderVars(interp);
  }
});

function runGame(opts){
  opts = opts || {};
  let game, problems;
  try {
    game = parse(currentText);
    problems = lint(game);
  } catch(e){
    player.reset();
    player.print('parse failure: ' + e.message, 'err');
    return;
  }
  lastGame = game;
  lastProblems = problems;
  renderSidebar(game, problems);
  updateStats();

  const errors = problems.filter(function(p){ return p.sev === 'error'; });
  if (errors.length){
    player.reset();
    player.print(errors.length + ' error' + (errors.length > 1 ? 's' : '') + '. Check the Problems view.', 'err');
    return;
  }
  player.start(game, { skipEffects: !!opts.skipEffects, hash: hashStr(currentText) });
}

$('btn-undo').onclick = function(){ player.undo(); };
$('btn-save-game').onclick = function(){ player.saveSlot(); };
$('btn-load-game').onclick = function(){ player.loadSlot(); };

