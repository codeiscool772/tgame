"""Cross-implementation conformance: the JavaScript reference runtime generated these cases
(see tgame_build/gen_conformance.js); the Python port must reproduce them exactly."""
import json
import math
import os

import pytest

import tgame
from tgame.core import Choice, match_choice

_PATH = os.path.join(os.path.dirname(__file__), "conformance.json")
DATA = json.load(open(_PATH, encoding="utf-8"))


def norm(v):
    # JSON stores numbers as shortest-round-trip digits, so compare as doubles
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return v
    f = float(v)
    if f != f:
        return "NaN"
    if f in (math.inf, -math.inf):
        return "Infinity" if f > 0 else "-Infinity"
    return f


def norm_vars(d):
    return dict((k, norm(v)) for k, v in d.items())


CASES = DATA["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_lint_matches_reference(case):
    game = tgame.loads(case["source"])
    got = sorted([p.n, p.sev, p.msg] for p in game.lint())
    want = sorted(case["lint"])
    assert got == want


RUNS = [(c["name"], i, r) for c in CASES for i, r in enumerate(c["runs"])]


@pytest.mark.parametrize("name,i,run", RUNS, ids=["%s#%d" % (n, i) for n, i, _ in RUNS])
def test_run_matches_reference(name, i, run):
    case = next(c for c in CASES if c["name"] == name)
    game = tgame.loads(case["source"])
    res = game.run(run["inputs"], seed=run["seedIn"])
    assert res.seed == run["seed"]
    assert res.lines == run["lines"]
    assert res.ended == run["ended"]
    assert res.error == run["error"]
    assert res.waiting == run["waiting"]
    assert norm_vars(res.vars) == norm_vars(run["vars"])
    assert dict((k, v) for k, v in res.lists.items()) == run["lists"]


@pytest.mark.parametrize("m", DATA["matcher"],
                         ids=["%d:%r" % (m["set"], m["text"]) for m in DATA["matcher"]])
def test_matcher_matches_reference(m):
    choices = [Choice(c["label"], c["aliases"], None, "", False) for c in m["choices"]]
    kind, val = match_choice(m["text"], choices, ["the", "a", "an"])
    assert [kind, val] == m["result"]
