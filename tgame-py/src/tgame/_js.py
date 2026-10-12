"""JavaScript-compatible value semantics.

The tgame format was specified by its first (JavaScript) runtime, so numbers,
equality and number-to-text follow JavaScript.  Keeping that exact behaviour is
what lets a game replay identically in every runtime.
"""
import math
import re
from decimal import Decimal

M32 = 0xFFFFFFFF


def to_int32(n):
    n &= M32
    return n - 0x100000000 if n & 0x80000000 else n


def mulberry32(seed):
    """Seeded RNG, bit-for-bit identical to the JavaScript runtime. Returns floats in [0, 1)."""
    a = seed & M32

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = ((a ^ (a >> 15)) * (1 | a)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def hash_str(s):
    """djb2 over UTF-16 code units, base 36 (matches the JS hashStr, used to tag saves)."""
    h = 5381
    data = s.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        h = (((h * 33) & M32) ^ (data[i] | (data[i + 1] << 8))) & M32
    if h == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while h:
        h, r = divmod(h, 36)
        out = digits[r] + out
    return out


_NUM_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$", re.ASCII)


def to_num(v):
    """JavaScript ToNumber for the three value types a game can hold."""
    if v is True:
        return 1.0
    if v is False:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "":
        return 0.0
    if _NUM_RE.match(s):
        return float(s)
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    return math.nan


def num_or0(v):
    """JavaScript `(+v) || 0`."""
    n = to_num(v)
    return 0.0 if (n != n or n == 0) else n


def truthy(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return not (v == 0 or v != v)
    return v != ""


def js_str(v):
    """JavaScript String(v)."""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return v
    f = float(v)
    if f != f:
        return "NaN"
    if f == math.inf:
        return "Infinity"
    if f == -math.inf:
        return "-Infinity"
    if f == 0:
        return "0"
    if f == int(f) and abs(f) < 9007199254740992.0:
        return str(int(f))
    if 1e-6 <= abs(f) < 1e21:
        # shortest round-trip digits, like JS (matters above 2**53, where exact ints differ)
        s = format(Decimal(repr(f)), "f")
        return s[:-2] if s.endswith(".0") else s
    mant, exp = repr(f).split("e")
    e = int(exp)
    return mant + "e" + ("+" if e > 0 else "-") + str(abs(e))


def loose_eq(a, b):
    """JavaScript `==` between numbers, strings and booleans."""
    if isinstance(a, bool):
        a = 1.0 if a else 0.0
        if isinstance(b, bool):
            return a == (1.0 if b else 0.0)
        return loose_eq(a, b)
    if isinstance(b, bool):
        return loose_eq(a, 1.0 if b else 0.0)
    a_str, b_str = isinstance(a, str), isinstance(b, str)
    if a_str and b_str:
        return a == b
    if a_str or b_str:
        return to_num(a) == to_num(b)
    return a == b


def compare(op, a, b):
    if isinstance(a, str) and isinstance(b, str):
        x, y = a, b
    else:
        x, y = to_num(a), to_num(b)
    if op == "<":
        return x < y
    if op == "<=":
        return x <= y
    if op == ">":
        return x > y
    return x >= y


def js_add(a, b):
    if isinstance(a, str) or isinstance(b, str):
        return js_str(a) + js_str(b)
    return to_num(a) + to_num(b)


def js_div(a, b):
    if b == 0:
        if a == 0 or a != a:
            return math.nan
        return math.inf if (a > 0) == (math.copysign(1.0, b) > 0) else -math.inf
    return a / b


def js_mod(a, b):
    if b == 0 or a != a or b != b or a in (math.inf, -math.inf):
        return math.nan
    if b in (math.inf, -math.inf):
        return a
    return math.fmod(a, b)
