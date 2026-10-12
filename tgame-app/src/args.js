'use strict';
/* Command-line handling, shared by first launch and second-instance forwarding.

   tgame.exe [--lite | --ide] [--line N] [path.tgame]

   No mode flag: with a file it plays it (Lite); without one it opens Lite's start screen.
   Windows runs "tgame.exe --lite "%1"" on double-click and "tgame.exe --ide "%1"" for
   the right-click "Edit with tgame IDE" entry. */
const path = require('path');

function parseArgs(argv, cwd) {
  const out = { mode: null, file: null, line: null, smoke: null, text: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lite') out.mode = 'lite';
    else if (a === '--ide') out.mode = 'ide';
    else if (a === '--line' && i + 1 < argv.length) out.line = toLine(argv[++i]);
    else if (a.startsWith('--line=')) out.line = toLine(a.slice(7));
    else if (a.startsWith('--smoke=')) out.smoke = a.slice(8);
    else if (a.startsWith('--')) continue;                       // Chromium / Electron switches
    else if (!out.file && a.length) out.file = path.resolve(cwd || process.cwd(), a);
  }
  if (!out.mode) out.mode = 'lite';
  return out;
}

function toLine(v) {
  const n = parseInt(v, 10);
  return n > 0 ? n : null;
}

/* process.argv in dev is [electron, appPath, ...args]; packaged it is [exe, ...args].
   Second-instance command lines follow the packaged shape. */
function userArgs(argv, defaultApp) {
  return argv.slice(defaultApp ? 2 : 1);
}

module.exports = { parseArgs, userArgs };
