'use strict';
/* npm test: argument parsing, then each window type is launched for real (hidden) and inspected. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, userArgs } = require('../src/args');

const appDir = path.join(__dirname, '..');
const electron = require('electron');            // path to electron.exe
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* ------------------------------------------------------------ arguments */
console.log('\narguments');
{
  const cwd = 'C:\\games';
  let a = parseArgs(['--lite', 'C:\\x y\\cave.tgame'], cwd);
  ok('lite + absolute path with a space', a.mode === 'lite' && a.file === 'C:\\x y\\cave.tgame', a);
  a = parseArgs(['--ide', 'cave.tgame', '--line', '12'], cwd);
  ok('ide, relative path resolved, --line N', a.mode === 'ide' && a.file === path.resolve(cwd, 'cave.tgame') && a.line === 12, a);
  a = parseArgs(['--ide=ignored', '--line=7', 'a.tgame'], cwd);
  ok('--line=N form', a.line === 7);
  a = parseArgs(['story.tgame'], cwd);
  ok('a bare file defaults to Lite', a.mode === 'lite' && a.file);
  a = parseArgs([], cwd);
  ok('no args: Lite start screen', a.mode === 'lite' && a.file === null);
  a = parseArgs(['--no-sandbox', '--lite', 'a.tgame'], cwd);
  ok('Chromium switches are ignored', a.file === path.resolve(cwd, 'a.tgame'));
  ok('packaged vs dev argv', userArgs(['tgame.exe', '--ide'], false)[0] === '--ide' && userArgs(['electron', '.', '--ide'], true)[0] === '--ide');
}

/* ------------------------------------------------------------ source encoding
   A UTF-8 BOM in package.json broke the release build once (@electron/rebuild uses a strict JSON.parse). */
console.log('\nencoding');
{
  const files = ['package.json', 'src/main.js', 'src/preload.js', 'src/args.js', 'scripts/sync.js', 'renderer/lite/lite.js', 'renderer/ide/index.html'];
  files.forEach(f => {
    const b = fs.readFileSync(path.join(appDir, f));
    let valid = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { valid = false; }
    ok(f + ': valid UTF-8, no BOM', valid && !(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF));
  });
  ok('package.json parses strictly', (() => { try { JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')); return true; } catch (e) { return false; } })());
}

/* ------------------------------------------------------------ real windows */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgame test ñ '));
const GOOD = '@format 3\n@title Smoke Story\n@start a\n:: a\nHello from the story.\n* Go on -> b\n:: b\nThe end.\n-> END\n';
const BAD = '@format 3\n:: a\n* Go -> nowhere\n';
const write = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text, 'utf8'); return p; };

function launch(args) {
  const r = spawnSync(electron, [appDir].concat(args), { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/SMOKE_RESULT (.*)/);
  const rendererErrors = (out.match(/RENDERER_ERROR .*/g) || []);
  return { result: m ? JSON.parse(m[1]) : null, rendererErrors, out, status: r.status };
}

console.log('\ntgame Lite');
{
  const good = write('good story.tgame', GOOD);
  let r = launch(['--lite', good, '--smoke=lite']);
  ok('Lite plays the file it was launched with', r.result && r.result.out.indexOf('Hello from the story.') >= 0, r.out.slice(-400));
  ok('Lite shows the story title', r.result && r.result.bar === 'Smoke Story' && /Smoke Story/.test(r.result.title), r.result);
  ok('Lite offers the choice as a button', r.result && r.result.choices === 1);
  ok('Lite has the host bridge', r.result && r.result.hostApp === true);
  ok('Lite: no renderer errors (CSP etc.)', r.rendererErrors.length === 0, r.rendererErrors);

  r = launch(['--lite', write('bad.tgame', BAD), '--smoke=lite']);
  ok('Lite shows problems instead of a broken game', r.result && r.result.problems > 0 && r.result.choices === 0, r.result);

  r = launch(['--lite', '--smoke=lite']);
  ok('Lite with no file shows the start screen', r.result && r.result.home === true, r.result);

  r = launch(['--lite', path.join(tmp, 'missing.tgame'), '--smoke=lite']);
  ok('Lite reports a missing file', r.result && r.result.problems > 0, r.result);

  const live = write('live.tgame', GOOD);
  r = launch(['--lite', live, '--smoke=lite-reload']);
  ok('Lite reloads when the file changes on disk', r.result && r.result.out.indexOf('reloaded') >= 0, r.result);
}

console.log('\ntgame IDE');
{
  const f = write('ide story.tgame', GOOD);
  let r = launch(['--ide', f, '--smoke=ide']);
  ok('IDE opens the file it was launched with', r.result && r.result.editor && r.result.editor.indexOf('@format 3') === 0, r.result);
  ok('IDE title carries the file name', r.result && /ide story\.tgame/.test(r.result.title), r.result);
  ok('IDE loaded CodeMirror locally', r.result && r.result.cm === 'function', r.result);
  ok('IDE has the host bridge', r.result && r.result.hostApp === true);
  ok('IDE lints it clean and runs it', r.result && r.result.problems === 0 && r.result.play.indexOf('Hello from the story.') >= 0, r.result);
  ok('IDE: no renderer errors (CSP etc.)', r.rendererErrors.length === 0, r.rendererErrors);

  r = launch(['--ide', f, '--line', '5', '--smoke=ide']);
  ok('IDE jumps to --line', r.result && r.result.line === 5, r.result);

  r = launch(['--ide', '--smoke=ide']);
  ok('IDE without a file starts untitled', r.result && /untitled/.test(r.result.title), r.result);

  const s = write('save me.tgame', GOOD);
  r = launch(['--ide', s, '--smoke=ide-save']);
  const after = fs.readFileSync(s, 'utf8');
  ok('IDE saves straight to the opened path', after.indexOf('// saved from the ide') >= 0 && after.indexOf('@title Smoke Story') >= 0, after.slice(-80));
  ok('IDE clears the unsaved marker after saving', r.result && r.result.dirty === false, r.result);
}


if (process.env.TGAME_TEST_UPDATES) {
  console.log('\nupdates (needs network + a published release)');
  const r = launch(['--smoke=update']);
  ok('app finds the newest GitHub release for a pretend-old version', r.result && r.result.available === true && /^\d+\.\d+\.\d+/.test(r.result.version), r.result || r.out.slice(-300));
  const same = (() => { process.env.TGAME_PRETEND_VERSION = '0.1.0'; const x = launch(['--smoke=update']); delete process.env.TGAME_PRETEND_VERSION; return x; })();
  ok('the current version is reported as up to date', same.result && same.result.available === false, same.result);
  ok('release carries the installer', r.result && (r.result.files || []).some(f => /^tgame-setup-.*\.exe$/.test(f)), r.result);
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
