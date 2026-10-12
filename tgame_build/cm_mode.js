/* ═══════════════════════════════════════════════════════════════════
   CODEMIRROR — tgame mode (line-aware, so prose is never mistaken for syntax)
   ═══════════════════════════════════════════════════════════════════ */
if (typeof CodeMirror !== 'undefined'){
  CodeMirror.defineMode('tgame', function(){
    const COND_KW = /^(and|or|not|has|no)\b/;
    const COND_ATOM = /^(visited|visits|inventory|random|count|true|false)\b/;
    const EFFECT_KW = /^(get|drop|add|remove|clear|once|enter)\b/;
    return {
      startState: function(){ return { kind: null, fence: false }; },
      token: function(stream, state){
        if (stream.sol()){
          state.kind = null;
          if (state.fence){
            if (stream.match(/^\s*```\s*$/)){ state.fence = false; return 'meta'; }
            stream.skipToEnd();
            return 'string';
          }
          if (stream.match(/^\s*```\s*$/)){ state.fence = true; return 'meta'; }
          if (stream.match(/^\s*\/\//)){ stream.skipToEnd(); return 'comment'; }
          if (stream.match(/^\s*\\/)){ state.kind = 'text'; return 'string-2'; }
          if (stream.match(/^\s*@\w+/)){ state.kind = 'directive'; return 'keyword'; }
          if (stream.match(/^\s*::/)){ state.kind = 'passage'; return 'keyword'; }
          if (stream.match(/^\s*\*/)){ state.kind = 'choice'; return 'keyword'; }
          if (stream.match(/^\s*\?(?=\s)/)){ state.kind = 'input'; return 'keyword'; }
          if (stream.match(/^\s*(->|>>)/)){ state.kind = 'jump'; return 'keyword'; }
          if (stream.match(/^\s*\.\.\.(\s.*)?$/)){ return 'atom'; }
          if (stream.match(/^\s*~\w+\s*$/)){ return 'atom'; }
          if (/^\s*if\s.*:\s*$/.test(stream.string)){ stream.match(/^\s*if\b/); state.kind = 'cond'; return 'keyword'; }
          if (stream.match(/^\s*(else:|end)\s*$/)){ return 'keyword'; }
          if (/^\s*\[.*\]\s*$/.test(stream.string)){ stream.match(/^\s*\[/); state.kind = 'effect'; return 'meta'; }
          state.kind = 'text';
        }

        const k = state.kind;
        if (stream.match(/^\\./)) return 'string-2';

        if (k === 'text' || k === 'choice' || k === 'input' || k === 'jump'){
          if (stream.match(/^\{[^{}]*\}/)) return 'variable-2';
          if (k !== 'text'){
            if (stream.match('->')) return 'keyword';
            if (stream.match(/^\[[^\]]*\]/)) return 'meta';
            if (k === 'choice' && stream.match('|')) return 'operator';
          }
          if (stream.match(/^\*\*[^*]+\*\*/)) return 'strong';
          if (stream.match(/^\*[^*]+\*/)) return 'em';
          stream.next();
          return null;
        }
        if (k === 'cond'){
          if (stream.eatSpace()) return null;
          if (stream.match(COND_KW)) return 'keyword';
          if (stream.match(COND_ATOM)) return 'atom';
          if (stream.match(/^\d+(\.\d+)?/)) return 'number';
          if (stream.match(/^("[^"]*"|'[^']*')/)) return 'string';
          if (stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u)) return 'variable-2';
          stream.next();
          return 'operator';
        }
        if (k === 'effect'){
          if (stream.eatSpace()) return null;
          if (stream.match(EFFECT_KW)) return 'keyword';
          if (stream.match(/^\d+(\.\d+)?/)) return 'number';
          if (stream.match(/^("[^"]*"|'[^']*')/)) return 'string';
          if (stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u)) return 'variable-2';
          if (stream.match(']')) return 'meta';
          stream.next();
          return 'operator';
        }
        if (k === 'directive'){
          if (stream.eatSpace()) return null;
          if (stream.match(/^\d+(\.\d+)?/)) return 'number';
          if (stream.match(/^("[^"]*"|'[^']*')/)) return 'string';
          if (stream.match(/^(true|false)\b/)) return 'atom';
          if (stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u)) return 'variable-2';
          stream.next();
          return 'operator';
        }
        if (k === 'passage'){
          if (stream.eatSpace()) return null;
          if (stream.match(/^#[\p{L}\p{N}_-]+/u)) return 'meta';
          if (stream.match(/^[\p{L}\p{N}_-]+/u)) return 'def';
          stream.next();
          return null;
        }
        stream.next();
        return null;
      }
    };
  });
}

