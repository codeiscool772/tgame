function buildEdges(game){
  const edges = new Map();
  const callTargets = new Set();
  for (let pi = 0; pi < game.order.length; pi++){
    const p = game.order[pi];
    const targets = new Set();
    for (let li = 0; li < p.lines.length; li++){
      const item = p.lines[li];
      const k = classifyLine(item);
      if (k.kind === 'jump'){
        const target = k.target.toLowerCase();
        if (target && target !== 'end') targets.add(target);
      } else if (k.kind === 'call'){
        const target = k.target.toLowerCase();
        if (target){ targets.add(target); callTargets.add(target); }
      } else if (k.kind === 'input'){
        const spec = parsePromptLine(item.text);
        if (spec && spec.target && spec.target.toUpperCase() !== 'END') targets.add(spec.target.toLowerCase());
      } else if (k.kind === 'choice'){
        const sc = splitChoice(item.text);
        if (sc.target && sc.target.toUpperCase() !== 'END') targets.add(sc.target.toLowerCase());
      }
    }
    edges.set(p.key, targets);
  }
  for (let pi = 0; pi < game.order.length; pi++){
    game.order[pi].isSnippet = callTargets.has(game.order[pi].key);
  }
  return edges;
}

/* an ending is an explicit -> END, or a passage that has no choices and no jump */
function isEnding(passage){
  if (passage.isSnippet) return false;
  let hasExit = false;
  for (let i = 0; i < passage.lines.length; i++){
    const item = passage.lines[i];
    const k = classifyLine(item);
    if (k.kind === 'jump'){
      if (k.target.toUpperCase() === 'END') return true;
      hasExit = true;
    } else if (k.kind === 'input'){
      const spec = parsePromptLine(item.text);
      if (spec && spec.target){
        if (spec.target.toUpperCase() === 'END') return true;
        hasExit = true;
      }
    } else if (k.kind === 'choice'){
      const sc = splitChoice(item.text);
      if (sc.target && sc.target.toUpperCase() === 'END') return true;
      hasExit = true;
    }
  }
  return !hasExit;
}

