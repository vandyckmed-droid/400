#!/usr/bin/env python3
"""Prototype: which oscillator, at which lookback, says something useful about
the weeks ahead for the names this site ranks, and for the universe as a whole?

Not part of the site. Nothing here is imported by build.py, backtest.py or
portfolio.py, and nothing here writes under data/. It writes results.json and
REPORT.md next to itself.

The question
------------
An oscillator is a bounded, mean-reverting reading of where a price sits
relative to its own recent past: RSI, the stochastic, Bollinger %b and the
like. Chart software ships them with textbook settings (RSI 14, bands 20/2)
that were never tuned to anything in particular. This script asks, for this
universe and this history, which family and which lookback actually predicts
forward returns, in which direction, and whether the answer holds up out of
sample. It then asks the two questions a holder of this ranking would ask:
does the oscillator improve the momentum score if blended into it, and does a
breadth version of it say anything about the universe's next month.

Method
------
1. Prices. With a vendor key set: the same six-year, point-in-time universe
   the backtest uses (MidCap 400 as it stood, plus the S&P 500 size tail
   picked on the day's market caps), fetched through build.py's cached client.
   Without a key: the three years of committed bars in data/bars/, which cover
   today's members only, so that run is a survivorship-biased preview.
2. Candidates. Four families, several lookbacks each, all computed on adjusted
   closes so both modes see identical maths:
     RSI(n)      Wilder's relative strength index
     STOCH(n)    close-only stochastic %K, smoothed by 3 days
     ZSCORE(n)   (close - SMA(n)) / stdev(close, n), i.e. Bollinger %b centred
     NROC(n)     n-day return divided by its own volatility over the window
   Every one reads high when the name is stretched above its recent range and
   low when it is stretched below it. Composites average the cross-sectional
   percentile of two or more of these.
3. Test. At each week end, rank every member on each candidate and correlate
   that rank with the rank of the return over 1 week, 2 weeks, 1 month and
   3 months (Spearman information coefficient, "IC"). A negative IC means
   stretched names go on to lag: mean reversion. A positive IC means they go
   on to lead: continuation. The IC is invariant to how the oscillator is
   scaled, so it compares families fairly. Decile means show whether any
   effect lives in the extremes rather than across the whole range.
4. Guard against overfitting. The sample is split in two by date. Lookbacks
   are chosen on the first half only; the second half is reported untouched.
   Neighbouring lookbacks are printed side by side, because a real effect
   shows up as a smooth ridge across lookbacks and a fluke as a lone spike.
   Per-year ICs show whether it is one regime or a habit.
5. Context. The same test is run inside the top and bottom fifth of the
   site's own momentum score ("buy the pullback in a leader?"), and the
   oscillator is blended into the momentum score at a few weights to see
   whether it adds anything the score does not already carry.
6. Breadth. The share of members above their n-day average is a universe-
   level oscillator. Its reading at each week end is set against the
   equal-weight universe's forward return, with the extremes bucketed.

Only the standard library is used, in keeping with the rest of the project.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = ROOT / "data"

# build.py refuses to import without a key because it is a publishing script.
# This one only borrows its momentum maths and, when a key exists, its price
# client. In offline mode the placeholder is never sent anywhere: no network
# call is made without a real key (see load_prices).
ONLINE = bool(os.environ.get("FMP_API_KEY") or os.environ.get("API_KEY"))
if not ONLINE:
    os.environ["FMP_API_KEY"] = "offline-prototype"
sys.path.insert(0, str(ROOT / "scripts"))
import build      # noqa: E402


def _read_only_snapshot(name: str, fetch, describe: str) -> dict:
    """build.snapshot rewrites data/<name>.json on a successful fetch. A
    prototype must not touch the published data, so use the fresh copy in
    memory and fall back to the committed file without ever writing it."""
    path = DATA / f"{name}.json"
    try:
        return fetch()
    except Exception as exc:  # noqa: BLE001
        if not path.exists():
            raise
        build.log(f"{describe}: fetch failed ({exc}); using committed snapshot")
        return json.loads(path.read_text())


build.snapshot = _read_only_snapshot

# --- Design space -------------------------------------------------------------

FAMILIES = {
    "RSI":    [5, 7, 10, 14, 21, 30, 42, 63],
    "STOCH":  [10, 14, 21, 30, 42, 63, 126],
    "ZSCORE": [10, 20, 30, 42, 63, 126],
    "NROC":   [5, 10, 15, 21, 30, 42, 63, 126],
}
# Composites: the mean of the cross-sectional percentiles of the parts, so a
# name stretched on both a two-week and a two-month view reads more stretched
# than one stretched on either alone.
COMPOSITES = {
    "SHORT":  [("RSI", 5), ("ZSCORE", 10)],
    "MID":    [("ZSCORE", 42), ("STOCH", 42)],
    "COMBO":  [("RSI", 5), ("ZSCORE", 10), ("ZSCORE", 42), ("STOCH", 42)],
}
HORIZONS = {"1w": 5, "2w": 10, "1m": 21, "3m": 63}   # trading days ahead
PRIMARY = "1m"           # the horizon lookbacks are optimised for; the site rebalances monthly
WARMUP = 130             # bars a name needs before its first reading (longest lookback + slack)
MIN_MEMBERS = 300        # skip a week end with fewer scored members than this
DECILES = 10
MOMENTUM_EDGE = 20       # top / bottom fifth of the momentum score for the conditional test
OVERLAY_WEIGHTS = (0.1, 0.25, 0.5)   # score - w * oscillator percentile
BREADTH_LOOKBACKS = (10, 20, 42, 63, 126)
BREADTH_LOW, BREADTH_HIGH = 0.25, 0.75   # washed-out / stretched bands on the share above average
BREADTH_PICK = 63                        # the lookback the report details; see README.md for why

log = build.log


# --- Prices -------------------------------------------------------------------

def load_prices():
    """-> (prices, calendar, members_at, source_note)

    prices: symbol -> (dates, closes), oldest first.
    members_at: date -> set of symbols that were members of the universe then.
    """
    if ONLINE:
        return load_prices_online()
    return load_prices_offline()


def load_prices_offline():
    prices = {}
    for path in sorted((DATA / "bars").glob("*.json")):
        bars = json.loads(path.read_text())
        if len(bars["dates"]) > WARMUP + HORIZONS["3m"]:
            prices[bars["symbol"]] = (bars["dates"], [float(c) for c in bars["c"]])
    calendar = build.trading_days({s: list(zip(d, c)) for s, (d, c) in prices.items()})
    members = set(prices)
    note = (f"OFFLINE PREVIEW: {len(prices)} current members from data/bars/, "
            f"{calendar[0]} to {calendar[-1]}. Today's members only, so names that "
            f"left the index are missing (survivorship bias) and the window is three "
            f"years, not six. Run with the vendor key for the real test.")
    return prices, calendar, (lambda date: members), note


def load_prices_online():
    import universes
    core_universe, core_changes = universes.load_core()
    sp500_universe, sp500_changes = universes.load_sp500()
    core_now = {c["symbol"] for c in core_universe}
    sp500_now = {c["symbol"] for c in sp500_universe}
    horizon_start = (dt.date.today() - dt.timedelta(days=365 * build.YEARS_OF_PRICES)).isoformat()
    ever = core_now | sp500_now
    for change in core_changes + sp500_changes:
        if change["date"] >= horizon_start and change["removed"]:
            ever.add(change["removed"])
    log(f"pricing {len(ever)} symbols")
    raw = build.fetch_all_prices(sorted(ever))
    prices = {s: ([d for d, _ in v], [c for _, c in v]) for s, v in raw.items()}
    calendar = build.trading_days(raw)

    dates = calendar[::5] + [calendar[-1]]          # membership is cheap to resolve; resolve it weekly
    core_at = universes.membership_history(core_now, core_changes, dates)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, dates)
    cap_symbols = sorted({s for d in dates for s in sp500_at[d]} & set(prices))
    caps = universes.fetch_market_caps(cap_symbols)
    members_cache = {}

    def members_at(date):
        key = dates[max(0, bisect_right(dates, date) - 1)]
        if key not in members_cache:
            tail = universes.size_tail(sp500_at[key] & set(prices), caps, key)
            members_cache[key] = (core_at[key] & set(prices)) | tail
        return members_cache[key]

    note = (f"SIX-YEAR POINT-IN-TIME RUN: {len(prices)} symbols priced, {calendar[0]} to "
            f"{calendar[-1]}; the universe is rebuilt as it stood at each week end, "
            f"the same reconstruction the backtest uses.")
    return prices, calendar, members_at, note


# --- Oscillators (close-only, oldest first, None until warmed up) ------------

def rsi(c: list[float], n: int) -> list:
    out = [None] * len(c)
    if len(c) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    ag, al = gains / n, losses / n
    out[n] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        ag = (ag * (n - 1) + max(d, 0.0)) / n
        al = (al * (n - 1) + max(-d, 0.0)) / n
        out[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return out


def stoch(c: list[float], n: int, smooth: int = 3) -> list:
    """%K on closes (no highs/lows, so both data modes agree), then SMA(smooth)."""
    k = [None] * len(c)
    for i in range(n - 1, len(c)):
        window = c[i - n + 1 : i + 1]
        lo, hi = min(window), max(window)
        k[i] = 50.0 if hi == lo else 100.0 * (c[i] - lo) / (hi - lo)
    out = [None] * len(c)
    for i in range(n - 1 + smooth - 1, len(c)):
        out[i] = sum(k[i - smooth + 1 : i + 1]) / smooth
    return out


def zscore(c: list[float], n: int) -> list:
    """(close - SMA(n)) / stdev(close over n): Bollinger %b, centred on zero."""
    out = [None] * len(c)
    s = s2 = 0.0
    for i, x in enumerate(c):
        s += x
        s2 += x * x
        if i >= n:
            s -= c[i - n]
            s2 -= c[i - n] ** 2
        if i >= n - 1:
            mean = s / n
            var = max(s2 / n - mean * mean, 0.0)
            sd = math.sqrt(var)
            out[i] = 0.0 if sd < 1e-12 else (x - mean) / sd
    return out


def nroc(c: list[float], n: int) -> list:
    """n-day return scaled by the volatility of that window: a t-statistic of
    the recent move, so a 10% climb in a sleepy name reads as stretched and
    the same climb in a wild one does not."""
    out = [None] * len(c)
    r = [0.0] + [math.log(c[i] / c[i - 1]) if c[i] > 0 and c[i - 1] > 0 else 0.0
                 for i in range(1, len(c))]
    s = s2 = 0.0
    for i in range(1, len(c)):
        s += r[i]
        s2 += r[i] * r[i]
        if i > n:
            s -= r[i - n]
            s2 -= r[i - n] ** 2
        if i >= n:
            mean = s / n
            sd = math.sqrt(max(s2 / n - mean * mean, 0.0))
            out[i] = 0.0 if sd < 1e-12 else (c[i] / c[i - n] - 1.0) / (sd * math.sqrt(n))
    return out


COMPUTE = {"RSI": rsi, "STOCH": stoch, "ZSCORE": zscore, "NROC": nroc}


# --- Statistics ---------------------------------------------------------------

def ranks(values: list[float]) -> list[float]:
    """Average ranks, ties shared."""
    order = sorted(range(len(values)), key=values.__getitem__)
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        r = (i + j) / 2.0
        for k in range(i, j + 1):
            out[order[k]] = r
        i = j + 1
    return out


def pearson(x: list[float], y: list[float]):
    mx, my = st.fmean(x), st.fmean(y)
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def spearman(x: list[float], y: list[float]):
    if len(x) < 10:
        return None
    return pearson(ranks(x), ranks(y))


def newey_west_t(values: list[float], lag: int) -> float:
    n = len(values)
    if n < 3:
        return float("nan")
    mean = st.fmean(values)
    resid = [v - mean for v in values]
    var = sum(v * v for v in resid) / n
    for L in range(1, min(lag, n - 1) + 1):
        cov = sum(resid[i] * resid[i - L] for i in range(L, n)) / n
        var += 2 * (1 - L / (lag + 1)) * cov
    return mean / math.sqrt(var / n) if var > 0 else float("nan")


def newey_west_slope_t(x: list[float], y: list[float], lag: int):
    """t-statistic of the slope of y on x, with the overlap correction on the
    regression scores. For a weekly series of h-week forward returns."""
    n = len(x)
    if n < 10:
        return None
    mx, my = st.fmean(x), st.fmean(y)
    sxx = sum((a - mx) ** 2 for a in x)
    if sxx <= 0:
        return None
    b = sum((a - mx) * (c - my) for a, c in zip(x, y)) / sxx
    a0 = my - b * mx
    u = [(a - mx) * (c - a0 - b * a) for a, c in zip(x, y)]     # regression scores
    var = sum(v * v for v in u)
    for L in range(1, min(lag, n - 1) + 1):
        cov = sum(u[i] * u[i - L] for i in range(L, n))
        var += 2 * (1 - L / (lag + 1)) * cov
    return b / math.sqrt(var) * sxx if var > 0 else None


def episodes(points: list[tuple[str, float, dict]], below: float | None = None,
             above: float | None = None) -> list[dict]:
    """Separate spells in which breadth sat past a band, with the forward
    return measured from the first week end of each spell: what someone acting
    on the first reading would have seen. Weeks inside a spell overlap heavily,
    so the number of spells is the honest sample size."""
    inside = (lambda v: v < below) if below is not None else (lambda v: v > above)
    out, current = [], None
    for date, share, fwd in points:
        if inside(share):
            if current is None:
                current = {"start": date, "weeks": 0, "extreme": share,
                           **{f"fwd{h}": fwd[h] for h in HORIZONS}}
            current["weeks"] += 1
            current["extreme"] = (min if below is not None else max)(current["extreme"], share)
        elif current is not None:
            out.append(current)
            current = None
    if current is not None:
        out.append(current)
    return out


def bucket_means(values: list[float], fwd: list[float], q: int) -> list[float]:
    """Mean forward return by quantile of `values`, lowest first."""
    order = sorted(range(len(values)), key=lambda i: (values[i], i))
    size = len(order) // q
    out = []
    for b in range(q):
        bucket = order[b * size : (b + 1) * size] if b < q - 1 else order[b * size :]
        out.append(st.fmean(fwd[i] for i in bucket))
    return out


def summarise(series: list[tuple[str, float]], lag: int) -> dict:
    vals = [v for _, v in series]
    return {
        "n": len(vals),
        "meanIC": st.fmean(vals) if vals else None,
        "t": newey_west_t(vals, lag) if vals else None,
        "reversalShare": (sum(1 for v in vals if v < 0) / len(vals)) if vals else None,
    }


def by_year(series: list[tuple[str, float]]) -> dict:
    years = defaultdict(list)
    for d, v in series:
        years[d[:4]].append(v)
    return {y: {"meanIC": st.fmean(v), "n": len(v)} for y, v in sorted(years.items())}


# --- Main ---------------------------------------------------------------------

def main() -> None:
    prices, calendar, members_at, note = load_prices()
    log(note)
    index = {d: i for i, d in enumerate(calendar)}
    last_h = HORIZONS["3m"]

    # Week ends we can read an oscillator at and still measure 3 months ahead.
    week_ends = build.week_end_dates(calendar, 10_000)
    eval_dates = [d for d in week_ends if index[d] >= WARMUP and index[d] + last_h < len(calendar)]
    log(f"{len(eval_dates)} week ends, {eval_dates[0]} to {eval_dates[-1]}")

    # Oscillator readings for every name, every config, computed once.
    base = [(f, n) for f, ns in FAMILIES.items() for n in ns]
    log(f"computing {len(base)} candidate oscillators for {len(prices)} names")
    osc = {}
    for symbol, (dates, closes) in prices.items():
        osc[symbol] = {cfg: COMPUTE[cfg[0]](closes, cfg[1]) for cfg in base}

    keys = [f"{f}({n})" for f, n in base] + list(COMPOSITES)
    ic = {k: {h: [] for h in HORIZONS} for k in keys}
    deciles = {k: {h: [] for h in HORIZONS} for k in keys}
    cond = {k: {edge: {h: [] for h in HORIZONS} for edge in ("leaders", "laggards")} for k in keys}
    momentum_ic = {h: [] for h in HORIZONS}
    overlay_ic = {k: {w: {h: [] for h in HORIZONS} for w in OVERLAY_WEIGHTS} for k in keys}
    breadth = []          # (date, {lookback: share above SMA}, {h: EW universe forward return})
    used = []

    for date in eval_dates:
        ci = index[date]
        members = members_at(date)
        rows = {}
        for symbol in members:
            entry = prices.get(symbol)
            if not entry:
                continue
            dates, closes = entry
            pos = bisect_right(dates, date) - 1
            if pos < WARMUP or dates[pos] != date:
                continue
            fwd = {}
            for h, days in HORIZONS.items():
                target = calendar[ci + days]
                j = bisect_right(dates, target) - 1
                if j <= pos:
                    j = len(dates) - 1            # series ended: hold to last print, then cash
                fwd[h] = closes[j] / closes[pos] - 1.0
            rows[symbol] = (pos, fwd)
        if len(rows) < MIN_MEMBERS:
            continue
        used.append(date)
        symbols = sorted(rows)

        # The site's own score on this date, for the conditional and overlay tests.
        legs = build.legs_at(set(symbols), prices, date)
        p12 = build.percentiles({s: v[0][0] for s, v in legs.items()})
        p6 = build.percentiles({s: v[1][0] for s, v in legs.items()})
        score = {s: 0.5 * p12[s] + 0.5 * p6[s] for s in legs}
        scored = [s for s in symbols if s in score]
        leaders = [s for s in scored if score[s] >= 100 - MOMENTUM_EDGE]
        laggards = [s for s in scored if score[s] <= MOMENTUM_EDGE]
        for h in HORIZONS:
            r = spearman([score[s] for s in scored], [rows[s][1][h] for s in scored])
            if r is not None:
                momentum_ic[h].append((date, r))

        # Raw readings per base config, then percentiles for the composites.
        readings = {}
        for cfg in base:
            vals = {s: osc[s][cfg][rows[s][0]] for s in symbols}
            readings[f"{cfg[0]}({cfg[1]})"] = {s: v for s, v in vals.items() if v is not None}
        for name, parts in COMPOSITES.items():
            part_pct = [build.percentiles(readings[f"{f}({n})"]) for f, n in parts]
            common = set.intersection(*(set(p) for p in part_pct))
            readings[name] = {s: st.fmean(p[s] for p in part_pct) for s in common}

        for key in keys:
            vals = readings[key]
            names = [s for s in symbols if s in vals]
            x = [vals[s] for s in names]
            for h in HORIZONS:
                y = [rows[s][1][h] for s in names]
                r = spearman(x, y)
                if r is not None:
                    ic[key][h].append((date, r))
                    deciles[key][h].append(bucket_means(x, y, DECILES))
                for edge, group in (("leaders", leaders), ("laggards", laggards)):
                    g = [s for s in group if s in vals]
                    if len(g) >= 30:
                        rg = spearman([vals[s] for s in g], [rows[s][1][h] for s in g])
                        if rg is not None:
                            cond[key][edge][h].append((date, rg))
            # Overlay: the momentum score less a slice of the oscillator's percentile.
            both = [s for s in scored if s in vals]
            if len(both) >= MIN_MEMBERS:
                pct_osc = build.percentiles({s: vals[s] for s in both})
                for w in OVERLAY_WEIGHTS:
                    blended = [score[s] - w * pct_osc[s] for s in both]
                    for h in HORIZONS:
                        r = spearman(blended, [rows[s][1][h] for s in both])
                        if r is not None:
                            overlay_ic[key][w][h].append((date, r))

        # Breadth: the share of members above their n-day average.
        shares = {}
        for n in BREADTH_LOOKBACKS:
            vals = readings[f"ZSCORE({n})"]
            shares[n] = sum(1 for v in vals.values() if v > 0) / len(vals) if vals else None
        ew = {h: st.fmean(rows[s][1][h] for s in symbols) for h in HORIZONS}
        breadth.append((date, shares, ew))

        if len(used) % 25 == 0:
            log(f"  {len(used)} week ends done ({date})")

    log(f"{len(used)} week ends used")

    # Breadth up to the most recent week end, past the point where forward
    # returns exist, so the latest reading is this week's and not three months
    # old. These points carry no forward return and take no part in the tests.
    for date in week_ends:
        if date <= used[-1] or index[date] < WARMUP:
            continue
        members = members_at(date)
        shares = {}
        for n in BREADTH_LOOKBACKS:
            above = total = 0
            for symbol in members:
                entry = prices.get(symbol)
                if not entry:
                    continue
                dates, closes = entry
                pos = bisect_right(dates, date) - 1
                if pos < WARMUP or dates[pos] != date:
                    continue
                v = osc[symbol][("ZSCORE", n)][pos]
                if v is not None:
                    total += 1
                    above += v > 0
            shares[n] = above / total if total >= MIN_MEMBERS else None
        if any(v is not None for v in shares.values()):
            breadth.append((date, shares, None))

    split = used[len(used) // 2]
    lag_of = {h: max(1, math.ceil(days / 5) - 1) for h, days in HORIZONS.items()}

    # --- Assemble results ---
    def block(series, h):
        train = [(d, v) for d, v in series if d < split]
        test = [(d, v) for d, v in series if d >= split]
        return {
            "all": summarise(series, lag_of[h]),
            "train": summarise(train, lag_of[h]),
            "test": summarise(test, lag_of[h]),
        }

    table = {}
    for key in keys:
        table[key] = {"horizons": {}}
        for h in HORIZONS:
            b = block(ic[key][h], h)
            ds = deciles[key][h]
            if ds:
                b["deciles"] = [st.fmean(d[i] for d in ds) for i in range(DECILES)]
                b["spreadHighMinusLow"] = b["deciles"][-1] - b["deciles"][0]
            b["byYear"] = by_year(ic[key][h])
            b["leaders"] = block(cond[key]["leaders"][h], h)["all"]
            b["laggards"] = block(cond[key]["laggards"][h], h)["all"]
            b["overlay"] = {str(w): block(overlay_ic[key][w][h], h) for w in OVERLAY_WEIGHTS}
            table[key]["horizons"][h] = b

    # Pick, per family, the lookback with the strongest train t-stat at the
    # primary horizon (either sign); then report what it did on the test half.
    def train_t(key):
        return abs(table[key]["horizons"][PRIMARY]["train"]["t"] or 0)

    winners = {family: max((f"{family}({n})" for n in ns), key=train_t)
               for family, ns in FAMILIES.items()}
    for name in COMPOSITES:
        winners[name] = name
    overall = max(winners.values(), key=train_t)

    # Breadth: time-series correlation with the universe's own forward return.
    breadth_out = {}
    for n in BREADTH_LOOKBACKS:
        pts = [(d, s[n], ew) for d, s, ew in breadth if s.get(n) is not None and ew is not None]
        whole = [(d, s.get(n)) for d, s, _ in breadth]
        per_h = {}
        for h in HORIZONS:
            x = [p[1] for p in pts]
            y = [p[2][h] for p in pts]
            lo = [p[2][h] for p in pts if p[1] < BREADTH_LOW]
            mid = [p[2][h] for p in pts if BREADTH_LOW <= p[1] <= BREADTH_HIGH]
            hi = [p[2][h] for p in pts if p[1] > BREADTH_HIGH]
            first = [p for p in pts if p[0] < split]
            second = [p for p in pts if p[0] >= split]
            per_h[h] = {
                "spearman": spearman(x, y),
                "spearmanTrain": spearman([p[1] for p in first], [p[2][h] for p in first]),
                "spearmanTest": spearman([p[1] for p in second], [p[2][h] for p in second]),
                "slopeT": newey_west_slope_t(x, y, lag_of[h]),
                "n": len(pts),
                "washedOut": {"n": len(lo), "mean": st.fmean(lo) if lo else None},
                "middle": {"n": len(mid), "mean": st.fmean(mid) if mid else None},
                "stretched": {"n": len(hi), "mean": st.fmean(hi) if hi else None},
            }
        latest = [(d, v) for d, v in whole if v is not None][-1]
        breadth_out[str(n)] = {
            "latest": latest[1],
            "latestDate": latest[0],
            "horizons": per_h,
            "washedOutEpisodes": episodes(pts, below=BREADTH_LOW),
            "stretchedEpisodes": episodes(pts, above=BREADTH_HIGH),
            # Aligned with universe.dates below; None where a lookback had too few names.
            "series": [None if v is None else round(v, 4) for _, v in whole],
        }
    universe_series = {
        "dates": [d for d, _, _ in breadth],
        "testedThrough": used[-1],
        **{f"fwd{h}": [None if ew is None else round(ew[h], 5) for _, _, ew in breadth]
           for h in HORIZONS},
    }

    results = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "online-six-year" if ONLINE else "offline-preview",
        "note": note,
        "weekEnds": len(used),
        "from": used[0], "to": used[-1], "split": split,
        "primaryHorizon": PRIMARY,
        "horizonsDays": HORIZONS,
        "composites": {k: [f"{f}({n})" for f, n in v] for k, v in COMPOSITES.items()},
        "momentumScoreIC": {h: block(momentum_ic[h], h) for h in HORIZONS},
        "winners": winners,
        "overall": overall,
        "table": table,
        "breadthBands": [BREADTH_LOW, BREADTH_HIGH],
        "breadthPick": BREADTH_PICK,
        "breadth": breadth_out,
        "universe": universe_series,
    }
    (HERE / "results.json").write_text(json.dumps(results, separators=(",", ":")) + "\n")
    (HERE / "REPORT.md").write_text(report(results))
    log("wrote results.json and REPORT.md")
    print()
    print(report(results))


# --- Report -------------------------------------------------------------------

def pct(x, digits=2):
    return "n/a" if x is None else f"{x:+.{digits}%}"


def num(x, digits=3):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:+.{digits}f}"


def report(r: dict) -> str:
    T = r["table"]
    P = r["primaryHorizon"]
    lines = []
    w = lines.append
    w("# Oscillator prototype: results")
    w("")
    w(f"Generated {r['generatedAt'][:10]}. Mode: **{r['mode']}**.")
    w("")
    w(r["note"])
    w("")
    w(f"{r['weekEnds']} week ends from {r['from']} to {r['to']}. Lookbacks were chosen on the "
      f"weeks before {r['split']} (\"train\") and checked on the weeks from then on (\"test\").")
    w("")
    w("## How to read the numbers")
    w("")
    w("- **IC** is the rank correlation, across all names on one week end, between the "
      "oscillator reading and the return that followed. It is averaged over all week ends.")
    w("- **Negative IC = mean reversion**: names reading stretched-high went on to lag, "
      "stretched-low went on to lead. Positive IC = continuation.")
    w("- **t** is the IC's t-statistic with the overlap correction. Beyond about ±2 is "
      "unlikely to be luck; beyond ±3 is solid. Same sign in train and test is the real test.")
    w("- **D1 / D10** are the mean forward returns of the lowest tenth of readings and the "
      "highest tenth, so an effect that lives only in the extremes still shows.")
    w("")
    w("## The site's own momentum score, for scale")
    w("")
    w("| horizon | IC (all) | t | IC train | IC test |")
    w("| --- | --- | --- | --- | --- |")
    for h, b in r["momentumScoreIC"].items():
        w(f"| {h} | {num(b['all']['meanIC'])} | {num(b['all']['t'], 2)} | "
          f"{num(b['train']['meanIC'])} | {num(b['test']['meanIC'])} |")
    w("")
    w(f"## Best lookback per family (chosen on train at {P}) and the composites")
    w("")
    w("| candidate | IC train | t train | IC test | t test | IC all | t all | D1 | D10 | D10−D1 |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for family, key in r["winners"].items():
        b = T[key]["horizons"][P]
        d = b.get("deciles") or [None] * DECILES
        mark = " **(overall pick)**" if key == r["overall"] else ""
        w(f"| {key}{mark} | {num(b['train']['meanIC'])} | {num(b['train']['t'], 2)} | "
          f"{num(b['test']['meanIC'])} | {num(b['test']['t'], 2)} | {num(b['all']['meanIC'])} | "
          f"{num(b['all']['t'], 2)} | {pct(d[0])} | {pct(d[-1])} | {pct(b.get('spreadHighMinusLow'))} |")
    w("")
    w("Composites: " + "; ".join(f"{k} = mean percentile of {', '.join(v)}"
                                for k, v in r["composites"].items()) + ".")
    w("")
    w("## Every candidate, every horizon (IC over the whole sample, t in brackets)")
    w("")
    w("| candidate | " + " | ".join(HORIZONS) + " |")
    w("| --- | " + " | ".join("---" for _ in HORIZONS) + " |")
    for key, row in T.items():
        cells = []
        for h in HORIZONS:
            b = row["horizons"][h]["all"]
            cells.append(f"{num(b['meanIC'])} ({num(b['t'], 1)})")
        w(f"| {key} | " + " | ".join(cells) + " |")
    w("")
    w("## Deciles for the picks (mean forward return, lowest reading to highest)")
    w("")
    w("| candidate | horizon | " + " | ".join(f"D{i + 1}" for i in range(DECILES)) + " |")
    w("| --- | --- | " + " | ".join("---" for _ in range(DECILES)) + " |")
    for key in dict.fromkeys(list(r["winners"].values())):
        for h in HORIZONS:
            d = T[key]["horizons"][h].get("deciles")
            if d:
                w(f"| {key} | {h} | " + " | ".join(pct(v, 1) for v in d) + " |")
    w("")
    w("## Year by year (IC at each horizon) for the picks")
    w("")
    years = sorted({y for key in r["winners"].values() for h in HORIZONS
                    for y in T[key]["horizons"][h]["byYear"]})
    w("| candidate | horizon | " + " | ".join(years) + " |")
    w("| --- | --- | " + " | ".join("---" for _ in years) + " |")
    for key in dict.fromkeys(list(r["winners"].values())):
        for h in HORIZONS:
            by = T[key]["horizons"][h]["byYear"]
            w(f"| {key} | {h} | " + " | ".join(num(by[y]["meanIC"]) if y in by else "n/a"
                                               for y in years) + " |")
    w("")
    w("## Inside the leaders and the laggards")
    w("")
    w("The same IC, measured only among the top fifth of the momentum score (leaders) "
      "and only among the bottom fifth (laggards). This is the \"buy the pullback in a "
      "strong name\" question: a negative IC among leaders means the leaders that had "
      "dipped went on to do better than the leaders that were stretched.")
    w("")
    w("| candidate | horizon | leaders IC | t | laggards IC | t |")
    w("| --- | --- | --- | --- | --- | --- |")
    for key in dict.fromkeys(list(r["winners"].values())):
        for h in HORIZONS:
            b = T[key]["horizons"][h]
            w(f"| {key} | {h} | {num(b['leaders']['meanIC'])} | {num(b['leaders']['t'], 2)} | "
              f"{num(b['laggards']['meanIC'])} | {num(b['laggards']['t'], 2)} |")
    w("")
    w("## As an overlay on the momentum score")
    w("")
    w("Score minus w × the oscillator's percentile, compared with the score alone. "
      "A higher IC than the score's own row above means the oscillator adds information; "
      "a lower one means it subtracts.")
    w("")
    w("| candidate | horizon | score alone | " + " | ".join(f"w={w_}" for w_ in OVERLAY_WEIGHTS)
      + " | test: score alone | " + " | ".join(f"test w={w_}" for w_ in OVERLAY_WEIGHTS) + " |")
    w("| --- | --- | --- | " + " | ".join("---" for _ in OVERLAY_WEIGHTS) + " | --- | "
      + " | ".join("---" for _ in OVERLAY_WEIGHTS) + " |")
    for key in dict.fromkeys(list(r["winners"].values())):
        for h in HORIZONS:
            ov = T[key]["horizons"][h]["overlay"]
            base_all = r["momentumScoreIC"][h]["all"]["meanIC"]
            base_test = r["momentumScoreIC"][h]["test"]["meanIC"]
            w(f"| {key} | {h} | {num(base_all)} | "
              + " | ".join(num(ov[str(w_)]["all"]["meanIC"]) for w_ in OVERLAY_WEIGHTS)
              + f" | {num(base_test)} | "
              + " | ".join(num(ov[str(w_)]["test"]["meanIC"]) for w_ in OVERLAY_WEIGHTS) + " |")
    w("")
    w("## Breadth: the universe as one oscillator")
    w("")
    lo, hi = r["breadthBands"]
    w(f"Share of members above their n-day average at each week end, against the "
      f"equal-weight universe's return that followed. **corr** is the rank correlation over "
      f"time (train | test halves beside it), **t** the overlap-corrected t-statistic of the "
      f"slope. Then the mean forward return when breadth was washed out (below {lo:.0%}), "
      f"ordinary, or stretched (above {hi:.0%}), with the number of weeks in brackets. Weeks "
      f"inside one spell overlap, so the spell counts further down are the honest sample size.")
    w("")
    latest_date = next(iter(r["breadth"].values()))["latestDate"]
    w(f"Latest readings are as of {latest_date}; the tests stop at {r['universe']['testedThrough']}, "
      f"the last week end with three months of returns after it.")
    w("")
    w("| lookback | latest | horizon | corr | train | test | t | washed-out (wks) | ordinary (wks) | stretched (wks) |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for n, b in r["breadth"].items():
        for h, v in b["horizons"].items():
            w(f"| {n}d | {pct(b['latest'], 0)} | {h} | {num(v['spearman'], 2)} | "
              f"{num(v['spearmanTrain'], 2)} | {num(v['spearmanTest'], 2)} | {num(v['slopeT'], 2)} | "
              f"{pct(v['washedOut']['mean'])} ({v['washedOut']['n']}) | "
              f"{pct(v['middle']['mean'])} ({v['middle']['n']}) | "
              f"{pct(v['stretched']['mean'])} ({v['stretched']['n']}) |")
    w("")
    pick = r["breadth"][str(r["breadthPick"])]
    w(f"### Spells past the bands, {r['breadthPick']}-day breadth")
    w("")
    w("Forward returns of the equal-weight universe measured from the **first** week end "
      "of each spell, i.e. what acting on the first reading would have seen.")
    w("")
    for label, key in (("Washed out", "washedOutEpisodes"), ("Stretched", "stretchedEpisodes")):
        eps = pick[key]
        w(f"**{label}** ({len(eps)} spells)")
        w("")
        w("| first week end | weeks in zone | extreme reading | next 1w | next 2w | next 1m | next 3m |")
        w("| --- | --- | --- | --- | --- | --- | --- |")
        for e in eps:
            w(f"| {e['start']} | {e['weeks']} | {pct(e['extreme'], 0)} | {pct(e['fwd1w'], 1)} | "
              f"{pct(e['fwd2w'], 1)} | {pct(e['fwd1m'], 1)} | {pct(e['fwd3m'], 1)} |")
        if eps:
            means = " | ".join(pct(st.fmean(e[f"fwd{h}"] for e in eps), 1) for h in HORIZONS)
            wins = " | ".join(f"{sum(1 for e in eps if e[f'fwd{h}'] > 0)}/{len(eps)}" for h in HORIZONS)
            w(f"| **mean** | | | {means} |")
            w(f"| **positive** | | | {wins} |")
        w("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
