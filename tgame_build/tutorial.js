const TUTORIAL = [
  { title: 'Welcome to tgame',
    body: '<p>tgame is a tiny language for text adventures. Every game is a single ' +
          'plain text file.</p>' +
          '<p>The <strong>editor</strong> is in the middle. The <strong>play panel</strong> ' +
          'at the bottom runs your game as you type. The <strong>activity rail</strong> ' +
          'on the far left switches views.</p>' +
          '<p style="color:var(--text-dim); font-size:12.5px">Press ' +
          '<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd> any time for the command palette.</p>' },
  { title: 'A passage is a place',
    body: '<p>Every location in your story is a <strong>passage</strong>. Start one ' +
          'with <code>:: name</code>.</p>' +
          '<p>Consecutive lines make one paragraph; a blank line starts a new one.</p>',
    code: '@format 3\n\n:: entrance\nYou stand at the mouth of a cave.\nA cold wind spills out.\n\nSomething moves in the dark.' },
  { title: 'Choices and inventory',
    body: '<p>A line starting with <code>*</code> gives the player a choice. Add a ' +
          'target to move; leave it off to <strong>stay in place</strong>.</p>' +
          '<p><code>[get X]</code> manages the inventory. <code>if has X:</code> checks it. ' +
          '<code>once</code> hides a choice after it is taken.</p>',
    code: '* Take the lamp -> entrance [get lamp, once]\n* Toggle the lantern [lamp = not lamp]\n* Go north -> dark_hall\n\nif has lamp:\nThe lamp glows.\nend' },
  { title: 'Pacing',
    body: '<p>A line that is just <code>...</code> waits half a second. Add a duration to taste.</p>' +
          '<p>Toggle the typewriter effect with <code>~type</code> and ' +
          '<code>~normal</code>. Click anywhere in the play panel to skip.</p>',
    code: 'The lights flicker.\n...\n... 800\nThe lights go out.\n\n~type\nA voice whispers your name.\n~normal' },
  { title: 'Save, restore, undo',
    body: '<p>Every game gets <strong>undo</strong>, <strong>save</strong> and <strong>load</strong> for free. ' +
          'Type them in the play panel or use its buttons.</p>' +
          '<p>It works because the engine is deterministic: a save is just the random seed plus the choices made.</p>' },
  { title: "That's the whole language",
    body: '<p>Everything you just read composes into complete games.</p>' +
          '<p>Press the <strong>?</strong> activity at the bottom of the rail for ' +
          'the full reference. Try an <strong>Example</strong> to see a finished game.</p>' +
          '<p style="color:var(--text-dim); font-size:12.5px">Now go write something strange.</p>',
    isLast: true }
];
