# tgame app

One installer, two apps:

| | opens when | what it is |
|---|---|---|
| **tgame Lite** | you double-click a `.tgame` | plays the story; reloads by itself when the file is saved; shows lint errors instead of a broken game |
| **tgame IDE** | you right-click → *Edit with tgame IDE* | the editor: passages, map, variables, problems panel, play panel, native Open/Save |

Both run from the same install (`tgame.exe --lite` / `--ide`). Lite and the IDE use the same engine (`runtime.js`), the one the
Python library (`pip install tgame`) is tested against.

## Build

```
npm install --include=dev      # --include=dev matters if NODE_ENV=production is set on your machine
npm run dist                   # sync -> tests -> dist\tgame-setup-<version>.exe
```

Other scripts: `npm start` (IDE/Lite from source), `npm run lite`, `npm run ide`, `npm test`.

## Where things come from

`npm run sync` assembles the renderer; nothing in `renderer/shared`, `renderer/ide/index.html` or `vendor` is edited by hand.

| output | source of truth |
|---|---|
| `renderer/shared/runtime.js`, `lint.js` | `..\tgame_build` (the engine) |
| `renderer/ide/index.html` | `..\Tgame-IDE.html` + the desktop patches in `scripts/sync.js` and `scripts/ide-host.js` |
| `vendor/codemirror.*` | `..\tgame_build\node_modules\codemirror` (no CDN at runtime) |
| `build/*.ico` | `python scripts/make-icons.py` |

## What the installer does

Per-user install (no admin prompt), `%LOCALAPPDATA%\Programs\tgame`. `build/installer.nsh` adds:

- `.tgame` → ProgId `tgame.Story`, with the file icon
- double-click / **Play with tgame Lite**: `tgame.exe --lite "%1"`
- right-click / **Edit with tgame IDE**: `tgame.exe --ide "%1"`
- Start-menu shortcuts *tgame Lite* and *tgame IDE*
- all of it removed again by the uninstaller

On Windows 11 the right-click entries are under **Show more options** (or Shift+F10).

## Command line

```
tgame.exe [--lite | --ide] [--line N] [file.tgame]
```

Launching a second time hands the file to the running instance (a new window), and opening a file that is already open
focuses its window.

## Not done yet

- The installer is **unsigned**, so Windows SmartScreen shows "unknown publisher" the first time. Fixing that needs a code-signing certificate.
- No auto-update.
- Windows only (Electron could do macOS/Linux, but the file-association work is Windows-specific).
