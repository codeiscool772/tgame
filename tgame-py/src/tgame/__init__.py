"""tgame — run and lightly manipulate .tgame text adventures.

    pip install tgame
    tgame game.tgame                  # play it in the terminal

    import tgame
    tgame.play("game.tgame")          # same thing from Python
    g = tgame.load("game.tgame")
    g.lint(); g.stats(); g.run([0, "take lamp"]); g.to_html()

Zero dependencies.  The language is described at the top of every .tgame IDE's help.
"""
import os

__version__ = "0.1.0"

from .core import (TGAME_FORMAT, TgameError, Event, Problem, Interp, Choice,
                   parse, eval_expr, match_choice)
from .game import Game, RunResult, PassageInfo, load, loads
from .lint import lint

__all__ = ["Game", "RunResult", "PassageInfo", "Problem", "TgameError", "Event", "Interp", "Choice",
           "TGAME_FORMAT", "load", "loads", "play", "run", "check", "to_html", "parse", "lint",
           "eval_expr", "match_choice", "__version__"]


def _coerce(source):
    """A Game, a path (str / PathLike), or the text of a game (anything containing a newline)."""
    if isinstance(source, Game):
        return source
    if isinstance(source, os.PathLike):
        return load(source)
    if isinstance(source, str):
        if "\n" in source or source.lstrip().startswith(("@", "::")):
            return loads(source)
        return load(source)
    raise TypeError("expected a Game, a path or tgame source text, got %s" % type(source).__name__)


def play(source, **options):
    """Play a game in the terminal.  `source` is a path, a Game, or source text.

    Options: seed, effects, save_dir, load.  Returns an exit status (0 = ok).
    """
    return _coerce(source).play(**options)


def run(source, inputs=(), seed=None):
    """Run a game headlessly with scripted answers; returns a RunResult."""
    return _coerce(source).run(inputs, seed=seed)


def check(source):
    """Lint a game; returns a list of Problem (empty = clean)."""
    return _coerce(source).lint()


def to_html(source, path=None):
    """The game as one self-contained HTML page (written to `path` if given)."""
    html = _coerce(source).to_html()
    if path:
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
    return html
