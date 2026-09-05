#!/usr/bin/env python3
"""Prototype: which moving-average crossover best times the peaks and valleys
of this universe's price charts, and how close to "perfect" is best?

Not part of the site. Nothing here is imported by build.py, backtest.py or
portfolio.py, and nothing here writes under data/. It writes results.json and
REPORT.md next to itself.

The question
------------
A moving-average cross is the oldest chart signal there is: hold a name while
its fast average sits above its slow average, step aside when it drops below.
Chart software ships it at textbook settings (50/200, 20/50, 10/30) that were
never tuned to anything. This script asks, for this universe and this history,
which two durations come closest to buying every valley and selling every peak,
how close that is, and whether the answer survives out of sample.

Method
------
1. Prices. With a vendor key set: the same six-year, point-in-time universe
   the backtest uses (MidCap 400 as it stood, plus the S&P 500 size tail
   picked on the day's market caps), fetched through build.py's cached client.
   Without a key: the three years of committed bars in data/bars/, which cover
   today's members only, so that run is a survivorship-biased preview.
2. Candidates. Every pair of a fast and a slow length from the grids below,
   fast shorter than slow, as simple and as exponential averages. A fast
   length of 1 is the close itself crossing the slow average. Every pair is
   judged from the same bar (the longest slow length) so none gets extra days.
3. Signal. At each close, long if fast > slow, otherwise in cash. The position
   applies to the next day's return, and each switch pays a one-way cost.
   Long/flat only: this is a holder's tool, not a short seller's.
4. Perfect timing, defined. A zigzag with a minimum reversal (10%, 20%, 30%)
   marks every peak and valley of each name after the fact. A trader who
   bought every valley and sold every peak earns the "ideal" return. The
   share of that the crossover keeps, net of costs, is its CAPTURE. Capture
   penalises both faults of a crossover at once: buying late after a valley
   and selling late after a peak (lag), and switching on moves that were not
   turns (whipsaw).
5. Timing, measured. For every real valley: was the crossover already long
   (held through the dip), did it buy before the next peak (and how many days
   later, how far above the low), or did it miss the whole leg. For every
   real peak: the mirror. Crosses that matched no turn are whipsaws.
6. Portfolio. For each pair, an equal-weight curve across every member: each
   name contributes its own crossover return on the days it is a member.
   Annualised return, volatility, worst fall, against the same universe held
   outright.
7. Guard against overfitting. The window is split in two by date. The pair is
   chosen on the first half only and reported on the second untouched. The
   whole grid is printed so a real optimum shows as a ridge and a fluke as a
   lone cell. A per-name fit (each name's own best pair on the first half) is
   judged on the second half against the one universal pair.

Only the standard library is used, in keeping with the rest of the project.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import statistics as st
import sys
from bisect import bisect_left, bisect_right
from operator import add, mul
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = ROOT / "data"

# build.py refuses to import without a key because it is a publishing script.
# This one only borrows its price client and calendar helper. In offline mode
# the placeholder is never sent anywhere: no network call is made without a
# real key (see load_prices).
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

FAST = [1, 3, 5, 8, 10, 13, 15, 20, 25, 30, 40, 50]
SLOW = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200]
KINDS = ("SMA", "EMA")
PAIRS = [(k, f, s) for k in KINDS for s in SLOW for f in FAST if f < s]
WARMUP = max(SLOW)        # every pair is judged from this bar onward
COST = 0.001              # one-way cost per switch, 0.1%: mid-cap spread plus slippage
SWINGS = (0.10, 0.20, 0.30)   # zigzag reversal thresholds that define a real peak or valley
PRIMARY = 0.20            # the threshold the pair is chosen on; see README.md for why
MIN_DAYS = WARMUP + 126   # a name needs six months after warm-up to count
CLASSICS = [("SMA", 50, 200), ("SMA", 20, 50), ("SMA", 10, 30), ("EMA", 12, 26)]
DETAIL_TOP = 5            # pairs given the full timing distribution in the report
DETAIL_EXTRA = [("SMA", 50, 200), ("SMA", 20, 50), ("SMA", 10, 30)]

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
        if len(bars["dates"]) >= MIN_DAYS:
            prices[bars["symbol"]] = (bars["dates"], [float(c) for c in bars["c"]])
    calendar = build.trading_days({s: list(zip(d, c)) for s, (d, c) in prices.items()})
    members = set(prices)
    note = (f"OFFLINE PREVIEW: {len(prices)} current members from data/bars/, "
            f"{calendar[0]} to {calendar[-1]}. Today's members only, so names that "
            f"left the index are missing (survivorship bias), the window is three "
            f"years, not six, and the first {WARMUP} bars are warm-up. Run with the "
            f"vendor key for the real test.")
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
    raw = {s: v for s, v in raw.items() if len(v) >= MIN_DAYS}
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
            f"{calendar[-1]}; each name counts toward the universe curve only on the days "
            f"it was a member, the same reconstruction the backtest uses. The first "
            f"{WARMUP} bars are warm-up.")
    return prices, calendar, members_at, note


# --- Averages and turning points ---------------------------------------------

def sma(c: list[float], n: int) -> list:
    if n == 1:
        return list(c)
    out = [None] * len(c)
    s = 0.0
    for i, x in enumerate(c):
        s += x
        if i >= n:
            s -= c[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(c: list[float], n: int) -> list:
    if n == 1:
        return list(c)
    out = [None] * len(c)
    k = 2.0 / (n + 1)
    e = sum(c[:n]) / n
    out[n - 1] = e
    for i in range(n, len(c)):
        e += k * (c[i] - e)
        out[i] = e
    return out


def zigzag(c: list[float], threshold: float) -> list[tuple[int, str]]:
    """Confirmed peaks ('H') and valleys ('L') of a close series: a peak is the
    highest close before a fall of at least `threshold` from it, a valley the
    lowest close before a rise of at least `threshold`. Alternates strictly."""
    pivots = []
    hi_i = lo_i = 0
    hi = lo = c[0]
    trend = 0                       # +1 rising from a valley, -1 falling from a peak
    for i in range(1, len(c)):
        x = c[i]
        if trend >= 0:
            if x > hi:
                hi, hi_i = x, i
            if x <= hi * (1 - threshold):
                if trend == 0 and lo_i < hi_i:
                    pivots.append((lo_i, "L"))
                pivots.append((hi_i, "H"))
                trend, lo, lo_i = -1, x, i
                continue
        if trend <= 0:
            if x < lo:
                lo, lo_i = x, i
            if x >= lo * (1 + threshold):
                if trend == 0 and hi_i < lo_i:
                    pivots.append((hi_i, "H"))
                pivots.append((lo_i, "L"))
                trend, hi, hi_i = 1, x, i
        if trend == 0:
            if x > hi:
                hi, hi_i = x, i
            if x < lo:
                lo, lo_i = x, i
    return pivots


def ideal_legs(c: list[float], pivots: list[tuple[int, str]]) -> list[tuple[int, int]]:
    """(start, end) index pairs a perfect long/flat trader would hold, including
    the open leg from the last valley to the end of the series."""
    legs = []
    for (i, a), (j, b) in zip(pivots, pivots[1:]):
        if a == "L" and b == "H":
            legs.append((i, j))
    if pivots and pivots[-1][1] == "L" and c[-1] > c[pivots[-1][0]]:
        legs.append((pivots[-1][0], len(c) - 1))
    if pivots and pivots[0][1] == "H" and c[pivots[0][0]] > c[0]:
        legs.insert(0, (0, pivots[0][0]))
    return legs


# --- Accumulators -------------------------------------------------------------

def zero_sums():
    return {"gross": 0.0, "net": 0.0, "bh": 0.0, "switches": 0, "days": 0, "names": 0,
            "beat": 0, "ideal": {t: 0.0 for t in SWINGS},
            "timing": {t: {"valleys": 0, "held": 0, "signalled": 0, "missed": 0,
                           "entryLag": 0.0, "entryPremium": 0.0,
                           "peaks": 0, "satOut": 0, "sold": 0, "rodeDown": 0,
                           "exitLag": 0.0, "exitDiscount": 0.0,
                           "crosses": 0, "matched": 0} for t in SWINGS}}


def match_turns(c, pos, ups, downs, pivots, acc, split_at, detail=None):
    """Score one name's crossover against its real turns. `acc` maps
    'train'/'test'/'all' to timing accumulators for one threshold."""
    for n, (i, kind) in enumerate(pivots):
        nxt = pivots[n + 1][0] if n + 1 < len(pivots) else len(c)
        halves = ("all", "train" if i < split_at else "test")
        before = pos[i - 1] if i > 0 else pos[0]
        if kind == "L":
            for h in halves:
                acc[h]["valleys"] += 1
            if before == 1:
                for h in halves:
                    acc[h]["held"] += 1
                continue
            k = bisect_left(ups, i)
            if k < len(ups) and ups[k] < nxt:
                b = ups[k]
                prem = c[b] / c[i] - 1
                for h in halves:
                    t = acc[h]
                    t["signalled"] += 1
                    t["matched"] += 1
                    t["entryLag"] += b - i
                    t["entryPremium"] += prem
                if detail is not None:
                    detail["entryLag"].append(b - i)
                    detail["entryPremium"].append(prem)
            else:
                for h in halves:
                    acc[h]["missed"] += 1
        else:
            for h in halves:
                acc[h]["peaks"] += 1
            if before == 0:
                for h in halves:
                    acc[h]["satOut"] += 1
                continue
            k = bisect_left(downs, i)
            if k < len(downs) and downs[k] < nxt:
                s_ = downs[k]
                disc = 1 - c[s_] / c[i]
                for h in halves:
                    t = acc[h]
                    t["sold"] += 1
                    t["matched"] += 1
                    t["exitLag"] += s_ - i
                    t["exitDiscount"] += disc
                if detail is not None:
                    detail["exitLag"].append(s_ - i)
                    detail["exitDiscount"].append(disc)
            else:
                for h in halves:
                    acc[h]["rodeDown"] += 1
    n_cross = len(ups) + len(downs)
    acc["all"]["crosses"] += n_cross
    tr = sum(1 for u in ups if u < split_at) + sum(1 for d in downs if d < split_at)
    acc["train"]["crosses"] += tr
    acc["test"]["crosses"] += n_cross - tr


# --- The study ----------------------------------------------------------------

def run(prices, calendar, members_at):
    cal_index = {d: i for i, d in enumerate(calendar)}
    N = len(calendar)
    split_cal = (N - 1 + WARMUP) // 2 + 1        # midpoint of the evaluation window, calendar index
    split_date = calendar[split_cal]
    cost_log = -math.log(1 - COST)

    sums = {p: {h: zero_sums() for h in ("all", "train", "test")} for p in PAIRS}
    port = {p: [0.0] * N for p in PAIRS}          # summed net simple returns by calendar day
    port_bh = [0.0] * N
    count = [0] * N
    per_name = {}                                 # symbol -> per-pair (net train, net test)
    ideal_by_name = {}                            # symbol -> {threshold: (train, test)}
    bh_by_name = {}

    symbols = sorted(prices)
    for n_done, sym in enumerate(symbols, 1):
        dates, c = prices[sym]
        n = len(c)
        if n < MIN_DAYS:
            continue
        ci = [cal_index[d] for d in dates]
        split_local = bisect_left(ci, split_cal)     # first local index in the test half
        if split_local <= WARMUP + 21 or split_local >= n - 21:
            pass                                     # a name may sit mostly in one half; still counts
        lr = [0.0] + [math.log(c[i] / c[i - 1]) for i in range(1, n)]
        sr = [0.0] + [c[i] / c[i - 1] - 1 for i in range(1, n)]
        # Evaluation region: positions at bars WARMUP..n-1, returns at WARMUP+1..n-1.
        e0 = WARMUP
        sp = max(split_local, e0 + 1)                # first return bar of the test half
        lr_eval = lr[e0 + 1:]
        sr_eval = sr[e0 + 1:]
        m = n - e0                                   # positions
        # Membership mask for the portfolio, per return bar.
        if ONLINE:
            mask = [1 if sym in members_at(dates[i]) else 0 for i in range(e0 + 1, n)]
        else:
            mask = None
        contiguous = ci[n - 1] - ci[e0 + 1] == n - e0 - 2
        a, b = ci[e0 + 1], ci[n - 1] + 1
        if mask is None:
            if contiguous:
                count[a:b] = [x + 1 for x in count[a:b]]
                port_bh[a:b] = map(add, port_bh[a:b], sr_eval)
            else:
                for i, x in zip(ci[e0 + 1:], sr_eval):
                    count[i] += 1
                    port_bh[i] += x
        else:
            for i, x, mk in zip(ci[e0 + 1:], sr_eval, mask):
                if mk:
                    count[i] += 1
                    port_bh[i] += x
        bh_train = sum(lr[e0 + 1:sp])
        bh_test = sum(lr[sp:])
        bh_by_name[sym] = (bh_train, bh_test)
        # Real turns, per threshold, on the evaluation region.
        c_eval = c[e0:]
        pivots = {t: zigzag(c_eval, t) for t in SWINGS}
        ideal = {}
        for t in SWINGS:
            tr = te = 0.0
            for i, j in ideal_legs(c_eval, pivots[t]):
                g = math.log(c_eval[j] / c_eval[i])
                if j + e0 < sp:
                    tr += g
                elif i + e0 >= sp:
                    te += g
                else:                                # a leg straddling the split: split it there
                    k = sp - e0
                    tr += math.log(c_eval[k - 1] / c_eval[i])
                    te += math.log(c_eval[j] / c_eval[k - 1])
            ideal[t] = (tr, te)
        ideal_by_name[sym] = ideal
        # Averages, once per length.
        avg = {"SMA": {}, "EMA": {}}
        for L in sorted(set(FAST) | set(SLOW)):
            avg["SMA"][L] = sma(c, L)[e0:]
            avg["EMA"][L] = ema(c, L)[e0:]
        split_pos = sp - e0                          # position index whose return bar starts the test half
        name_row = {}
        for p in PAIRS:
            kind, f, s = p
            fa, sl = avg[kind][f], avg[kind][s]
            pos = [1 if x > y else 0 for x, y in zip(fa, sl)]
            switches = [i for i in range(1, m) if pos[i] != pos[i - 1]]
            ups = [i for i in switches if pos[i] == 1]
            downs = [i for i in switches if pos[i] == 0]
            held = pos[:-1]                          # position applied to return bar e0+1+i
            gross_tr = sum(map(mul, held[:split_pos - 1], lr_eval[:split_pos - 1]))
            gross_te = sum(map(mul, held[split_pos - 1:], lr_eval[split_pos - 1:]))
            sw_tr = sum(1 for i in switches if i < split_pos)
            sw_te = len(switches) - sw_tr
            net_tr = gross_tr - sw_tr * cost_log
            net_te = gross_te - sw_te * cost_log
            name_row[p] = (net_tr, net_te)
            for h, g, nt, sw, bh, dcount in (("train", gross_tr, net_tr, sw_tr, bh_train, split_pos - 1),
                                             ("test", gross_te, net_te, sw_te, bh_test, m - split_pos),
                                             ("all", gross_tr + gross_te, net_tr + net_te,
                                              sw_tr + sw_te, bh_train + bh_test, m - 1)):
                S = sums[p][h]
                S["gross"] += g
                S["net"] += nt
                S["bh"] += bh
                S["switches"] += sw
                S["days"] += dcount
                S["names"] += 1
                S["beat"] += 1 if nt > bh else 0
            for t in SWINGS:
                sums[p]["train"]["ideal"][t] += ideal[t][0]
                sums[p]["test"]["ideal"][t] += ideal[t][1]
                sums[p]["all"]["ideal"][t] += ideal[t][0] + ideal[t][1]
                match_turns(c_eval, pos, ups, downs, pivots[t],
                            {h: sums[p][h]["timing"][t] for h in ("all", "train", "test")},
                            split_pos)
            # Portfolio contribution: net simple return per return bar.
            contrib = list(map(mul, held, sr_eval))
            for i in switches:
                contrib[i - 1] -= COST               # the switch at close i is paid on that bar
            if mask is not None:
                contrib = list(map(mul, contrib, mask))
                pr = port[p]
                for i, x in zip(ci[e0 + 1:], contrib):
                    pr[i] += x
            elif contiguous:
                port[p][a:b] = map(add, port[p][a:b], contrib)
            else:
                pr = port[p]
                for i, x in zip(ci[e0 + 1:], contrib):
                    pr[i] += x
        per_name[sym] = name_row
        if n_done % 100 == 0:
            log(f"  {n_done}/{len(symbols)} names")

    return {"sums": sums, "port": port, "portBH": port_bh, "count": count,
            "perName": per_name, "ideal": ideal_by_name, "bh": bh_by_name,
            "splitCal": split_cal, "splitDate": split_date, "costLog": cost_log}


# --- Detail pass for a few pairs: full timing distributions ------------------

def detail_pass(prices, pairs, threshold):
    out = {}
    for p in pairs:
        kind, f, s = p
        d = {"entryLag": [], "entryPremium": [], "exitLag": [], "exitDiscount": [],
             "netByName": [], "bhByName": [], "switchesByName": []}
        dummy = {h: zero_sums()["timing"][threshold] for h in ("all", "train", "test")}
        for sym in sorted(prices):
            dates, c = prices[sym]
            n = len(c)
            if n < MIN_DAYS:
                continue
            e0 = WARMUP
            c_eval = c[e0:]
            fa = (sma if kind == "SMA" else ema)(c, f)[e0:]
            sl = (sma if kind == "SMA" else ema)(c, s)[e0:]
            pos = [1 if x > y else 0 for x, y in zip(fa, sl)]
            m = len(pos)
            switches = [i for i in range(1, m) if pos[i] != pos[i - 1]]
            ups = [i for i in switches if pos[i] == 1]
            downs = [i for i in switches if pos[i] == 0]
            match_turns(c_eval, pos, ups, downs, zigzag(c_eval, threshold), dummy, m + 1, d)
            lr = [math.log(c_eval[i] / c_eval[i - 1]) for i in range(1, m)]
            net = sum(map(mul, pos[:-1], lr)) + len(switches) * math.log(1 - COST)
            d["netByName"].append(net)
            d["bhByName"].append(sum(lr))
            d["switchesByName"].append(len(switches))
        out[p] = d
    return out


# --- Statistics ---------------------------------------------------------------

def series_stats(daily: list[float]) -> dict:
    """Annualised return, volatility, Sharpe and worst fall of a daily simple-return series."""
    if not daily:
        return {"annReturn": None, "annVol": None, "sharpe": None, "maxDrawdown": None, "days": 0}
    nav = 1.0
    peak = 1.0
    mdd = 0.0
    logs = []
    for r in daily:
        nav *= 1 + r
        logs.append(math.log(1 + r))
        peak = max(peak, nav)
        mdd = min(mdd, nav / peak - 1)
    years = len(daily) / 252
    ann = nav ** (1 / years) - 1 if years > 0 else None
    vol = st.pstdev(logs) * math.sqrt(252) if len(logs) > 1 else None
    mean = sum(logs) / len(logs) * 252
    sharpe = mean / vol if vol else None
    return {"annReturn": ann, "annVol": vol, "sharpe": sharpe, "maxDrawdown": mdd,
            "days": len(daily), "final": nav}


def portfolio_daily(summed: list[float], count: list[int], lo: int, hi: int) -> list[float]:
    return [summed[i] / count[i] for i in range(lo, hi) if count[i] > 0]


def pooled(S: dict) -> dict:
    """Per-name pooled figures: annualised log returns and capture ratios."""
    days = S["days"] or 1
    out = {
        "annNet": math.exp(S["net"] / days * 252) - 1,
        "annGross": math.exp(S["gross"] / days * 252) - 1,
        "annBH": math.exp(S["bh"] / days * 252) - 1,
        "switchesPerYear": S["switches"] / days * 252,
        "shareBeatingBH": S["beat"] / S["names"] if S["names"] else None,
        "capture": {str(t): (S["net"] / S["ideal"][t] if S["ideal"][t] else None) for t in SWINGS},
        "idealAnn": {str(t): math.exp(S["ideal"][t] / days * 252) - 1 for t in SWINGS},
        "timing": {},
    }
    for t in SWINGS:
        T = S["timing"][t]
        v, pk = T["valleys"] or 1, T["peaks"] or 1
        out["timing"][str(t)] = {
            "valleys": T["valleys"], "peaks": T["peaks"],
            "heldThrough": T["held"] / v, "signalled": T["signalled"] / v, "missed": T["missed"] / v,
            "entryLag": T["entryLag"] / T["signalled"] if T["signalled"] else None,
            "entryPremium": T["entryPremium"] / T["signalled"] if T["signalled"] else None,
            "satOut": T["satOut"] / pk, "sold": T["sold"] / pk, "rodeDown": T["rodeDown"] / pk,
            "exitLag": T["exitLag"] / T["sold"] if T["sold"] else None,
            "exitDiscount": T["exitDiscount"] / T["sold"] if T["sold"] else None,
            "crosses": T["crosses"], "matched": T["matched"],
            "whipsawPerTurn": (T["crosses"] - T["matched"]) / (T["valleys"] + T["peaks"])
            if T["valleys"] + T["peaks"] else None,
        }
        d = out["timing"][str(t)]
        turns = T["valleys"] + T["peaks"]
        d["precision"] = T["matched"] / T["crosses"] if T["crosses"] else None
        d["recall"] = T["matched"] / turns if turns else None
        pr, rc = d["precision"], d["recall"]
        d["f1"] = 2 * pr * rc / (pr + rc) if pr and rc else None
    return out


def rank_correlation(xs: list[float], ys: list[float]) -> float:
    """Spearman correlation between two orderings of the same items."""
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for pos, i in enumerate(order):
            r[i] = pos
        return r
    a, b = ranks(xs), ranks(ys)
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = math.sqrt(sum((x - ma) ** 2 for x in a))
    vb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (va * vb) if va and vb else 0.0


LADDER = [(0, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 4.0), (4.0, 99.0)]   # whipsaws per real turn


def key(p) -> str:
    return f"{p[0]} {p[1]}/{p[2]}"


def median(xs):
    return st.median(xs) if xs else None


def quantile(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# --- Main ---------------------------------------------------------------------

def main() -> None:
    prices, calendar, members_at, note = load_prices()
    mode = "online (six-year point-in-time)" if ONLINE else "offline preview (committed bars)"
    log(f"{len(prices)} names, {len(PAIRS)} pairs, mode: {mode}")
    R = run(prices, calendar, members_at)
    sums, port, count = R["sums"], R["port"], R["count"]
    N = len(calendar)
    lo, sp = WARMUP + 1, R["splitCal"]
    bh_curve = {"all": series_stats(portfolio_daily(R["portBH"], count, lo, N)),
                "train": series_stats(portfolio_daily(R["portBH"], count, lo, sp)),
                "test": series_stats(portfolio_daily(R["portBH"], count, sp, N))}

    table = {}
    for p in PAIRS:
        row = {"kind": p[0], "fast": p[1], "slow": p[2]}
        for h, (x, y) in (("all", (lo, N)), ("train", (lo, sp)), ("test", (sp, N))):
            row[h] = pooled(sums[p][h])
            row[h]["portfolio"] = series_stats(portfolio_daily(port[p], count, x, y))
        table[key(p)] = row

    P = str(PRIMARY)

    def capture(k, h, t=P):
        return table[k][h]["capture"][t] or -9

    # Picks on the training half, by several objectives.
    keys = list(table)
    picks = {
        "capture": max(keys, key=lambda k: capture(k, "train")),
        "captureSMA": max([k for k in keys if k.startswith("SMA")], key=lambda k: capture(k, "train")),
        "captureEMA": max([k for k in keys if k.startswith("EMA")], key=lambda k: capture(k, "train")),
        "sharpe": max(keys, key=lambda k: table[k]["train"]["portfolio"]["sharpe"] or -9),
        "return": max(keys, key=lambda k: table[k]["train"]["portfolio"]["annReturn"] or -9),
        "drawdown": max(keys, key=lambda k: table[k]["train"]["portfolio"]["maxDrawdown"] or -9),
    }
    for t in SWINGS:
        picks[f"capture@{t}"] = max(keys, key=lambda k: capture(k, "train", str(t)))
        picks[f"f1@{t}"] = max(keys, key=lambda k: table[k]["train"]["timing"][str(t)]["f1"] or -9)
    picks["turnF1"] = max(keys, key=lambda k: table[k]["train"]["timing"][P]["f1"] or -9)
    pick = picks["capture"]
    # Ranks on test, to say where the training pick landed out of sample.
    test_order = sorted(keys, key=lambda k: -capture(k, "test"))
    test_rank = {k: i + 1 for i, k in enumerate(test_order)}
    all_order = sorted(keys, key=lambda k: -capture(k, "all"))
    f1_test_order = sorted(keys, key=lambda k: -(table[k]["test"]["timing"][P]["f1"] or -9))
    f1_test_rank = {k: i + 1 for i, k in enumerate(f1_test_order)}
    stability = {
        "captureRankCorrelation": rank_correlation([capture(k, "train") for k in keys],
                                                   [capture(k, "test") for k in keys]),
        "f1RankCorrelation": rank_correlation([table[k]["train"]["timing"][P]["f1"] or 0 for k in keys],
                                              [table[k]["test"]["timing"][P]["f1"] or 0 for k in keys]),
        "curveRankCorrelation": rank_correlation(
            [table[k]["train"]["portfolio"]["annReturn"] or 0 for k in keys],
            [table[k]["test"]["portfolio"]["annReturn"] or 0 for k in keys]),
        "testRankOfF1Pick": f1_test_rank[picks["turnF1"]],
    }
    # The speed ladder: within each band of whipsaws per turn, the pair with the
    # best capture over the whole sample, so the trade-off can be read as a menu.
    ladder = []
    for lo_w, hi_w in LADDER:
        band = [k for k in keys
                if (table[k]["all"]["timing"][P]["whipsawPerTurn"] or 0) >= lo_w
                and (table[k]["all"]["timing"][P]["whipsawPerTurn"] or 0) < hi_w]
        if band:
            ladder.append({"band": [lo_w, hi_w], "pairs": len(band),
                           "best": max(band, key=lambda k: capture(k, "all"))})

    # Per-name fit: each name's own best pair on train, judged on test.
    per_name_fit = {"names": 0, "fitNetTest": 0.0, "universalNetTest": 0.0, "bhTest": 0.0,
                    "idealTest": 0.0, "fitBeatsUniversal": 0, "fast": [], "slow": [], "kinds": {}}
    pk = (table[pick]["kind"], table[pick]["fast"], table[pick]["slow"])
    for sym, row in R["perName"].items():
        best = max(PAIRS, key=lambda p: row[p][0] / (R["ideal"][sym][PRIMARY][0] or 1e-9)
                   if R["ideal"][sym][PRIMARY][0] > 0 else row[p][0])
        per_name_fit["names"] += 1
        per_name_fit["fitNetTest"] += row[best][1]
        per_name_fit["universalNetTest"] += row[pk][1]
        per_name_fit["bhTest"] += R["bh"][sym][1]
        per_name_fit["idealTest"] += R["ideal"][sym][PRIMARY][1]
        per_name_fit["fitBeatsUniversal"] += 1 if row[best][1] > row[pk][1] else 0
        per_name_fit["fast"].append(best[1])
        per_name_fit["slow"].append(best[2])
        per_name_fit["kinds"][best[0]] = per_name_fit["kinds"].get(best[0], 0) + 1
    fits = per_name_fit
    fits["summary"] = {
        "fitCaptureTest": fits["fitNetTest"] / fits["idealTest"] if fits["idealTest"] else None,
        "universalCaptureTest": fits["universalNetTest"] / fits["idealTest"] if fits["idealTest"] else None,
        "bhCaptureTest": fits["bhTest"] / fits["idealTest"] if fits["idealTest"] else None,
        "shareFitBeatsUniversal": fits["fitBeatsUniversal"] / fits["names"] if fits["names"] else None,
        "fastMedian": median(fits["fast"]), "fastQ1": quantile(fits["fast"], 0.25),
        "fastQ3": quantile(fits["fast"], 0.75),
        "slowMedian": median(fits["slow"]), "slowQ1": quantile(fits["slow"], 0.25),
        "slowQ3": quantile(fits["slow"], 0.75),
        "kinds": fits["kinds"],
    }
    del fits["fast"], fits["slow"]

    # Per-year portfolio returns for the pick, the classics and buy-and-hold.
    years = sorted({d[:4] for d in calendar[lo:]})
    year_rows = {}
    for label, series in [("universe held outright", R["portBH"])] + \
            [(k, port[(table[k]["kind"], table[k]["fast"], table[k]["slow"])])
             for k in [pick] + [key(c) for c in CLASSICS if key(c) in table and key(c) != pick]]:
        year_rows[label] = {}
        for y in years:
            idx = [i for i in range(lo, N) if calendar[i][:4] == y and count[i] > 0]
            nav = 1.0
            for i in idx:
                nav *= 1 + series[i] / count[i]
            year_rows[label][y] = nav - 1

    # Full timing distributions for the leaders and the classics.
    detail_pairs = []
    f1_all_order = sorted(keys, key=lambda k: -(table[k]["all"]["timing"][P]["f1"] or -9))
    for k in all_order[:DETAIL_TOP] + [pick, picks["turnF1"], f1_all_order[0]] + \
            [key(c) for c in DETAIL_EXTRA]:
        p = (table[k]["kind"], table[k]["fast"], table[k]["slow"])
        if p in PAIRS and p not in detail_pairs:
            detail_pairs.append(p)
    log(f"detail pass on {len(detail_pairs)} pairs")
    details = {}
    for p, d in detail_pass(prices, detail_pairs, PRIMARY).items():
        details[key(p)] = {
            "entryLagMedian": median(d["entryLag"]), "entryLagQ3": quantile(d["entryLag"], 0.75),
            "entryPremiumMedian": median(d["entryPremium"]),
            "entryPremiumQ3": quantile(d["entryPremium"], 0.75),
            "exitLagMedian": median(d["exitLag"]), "exitLagQ3": quantile(d["exitLag"], 0.75),
            "exitDiscountMedian": median(d["exitDiscount"]),
            "exitDiscountQ3": quantile(d["exitDiscount"], 0.75),
            "netMedianByName": median(d["netByName"]),
            "bhMedianByName": median(d["bhByName"]),
            "excessMedianByName": median([a - b for a, b in zip(d["netByName"], d["bhByName"])]),
            "switchesMedianByName": median(d["switchesByName"]),
            "names": len(d["netByName"]),
        }

    # Neighbourhood grids: capture over the whole sample, by kind.
    grids = {}
    for kind in KINDS:
        grids[kind] = {h: {str(f): {str(s): (table[key((kind, f, s))][h]["capture"][P]
                                             if (kind, f, s) in PAIRS else None)
                                    for s in SLOW} for f in FAST}
                       for h in ("all", "train", "test")}

    eval_days = sum(1 for i in range(lo, N) if count[i] > 0)
    results = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "mode": mode, "online": ONLINE, "note": note,
        "from": calendar[lo], "to": calendar[-1], "split": R["splitDate"],
        "evalDays": eval_days, "names": len(R["perName"]),
        "design": {"fast": FAST, "slow": SLOW, "kinds": list(KINDS), "warmup": WARMUP,
                   "cost": COST, "swings": list(SWINGS), "primarySwing": PRIMARY},
        "buyAndHold": bh_curve,
        "picks": picks, "pick": pick, "testRankOfPick": test_rank[pick],
        "stability": stability, "ladder": ladder,
        "testOrder": test_order[:10], "allOrder": all_order[:10],
        "table": table, "grids": grids, "details": details, "years": year_rows,
        "perNameFit": fits["summary"],
    }
    (HERE / "results.json").write_text(json.dumps(results, indent=1, sort_keys=True) + "\n")
    (HERE / "REPORT.md").write_text(report(results))
    log(f"pick {pick}; wrote results.json and REPORT.md")


# --- Report -------------------------------------------------------------------

def pct(x, digits=1):
    return "n/a" if x is None else f"{x:+.{digits}%}"


def upct(x, digits=0):
    return "n/a" if x is None else f"{x:.{digits}%}"


def num(x, digits=2):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{digits}f}"


def days(x):
    return "n/a" if x is None else f"{x:.0f}d"


def report(r: dict) -> str:
    T = r["table"]
    P = str(r["design"]["primarySwing"])
    pick = r["pick"]
    lines = []
    w = lines.append
    w("# Moving-average cross prototype: results")
    w("")
    w(f"Generated {r['generatedAt'][:10]}. Mode: **{r['mode']}**.")
    w("")
    w(r["note"])
    w("")
    w(f"{r['names']} names, {r['evalDays']} trading days judged, {r['from']} to {r['to']}. "
      f"Durations were chosen on the days before {r['split']} (\"train\") and checked on the "
      f"days from then on (\"test\"). Each switch costs {r['design']['cost']:.1%} one way.")
    w("")
    w("## How to read the numbers")
    w("")
    w("- **Capture** is the share of a perfect trader's profit that the crossover kept, net of "
      "costs. The perfect trader buys every valley and sells every peak of every name, where a "
      f"peak or valley is a turn of at least {float(P):.0%} (the primary definition; 10% and 30% "
      "are shown for comparison). 100% would be perfect timing; a crossover loses to lag and to "
      "whipsaw. Buy-and-hold has a capture of its own, and beating it is the bar.")
    w("- **Entry premium** is how far above the valley the crossover bought, **exit discount** how "
      "far below the peak it sold, when it did signal. **Lag** is the days between the turn and "
      "the signal.")
    w("- **Held through / sat out** means the crossover never left before the valley (or never "
      "re-entered before the peak), so there was no signal to be late with. **Missed / rode "
      "down** means it stayed out for the whole rise, or stayed in for the whole fall.")
    w("- **Whipsaw per turn**: crosses that matched no real turn, per real turn. Zero is ideal.")
    w("- **Universe curve**: every member held under the crossover rule, equal weight, daily, "
      "against the same universe held outright.")
    w("")
    w("## Buy-and-hold, for scale")
    w("")
    w("| window | universe held outright, a year | volatility | worst fall | perfect-timing "
      "capture of buy-and-hold |")
    w("| --- | --- | --- | --- | --- |")
    for h in ("train", "test", "all"):
        b = r["buyAndHold"][h]
        any_row = T[pick][h]
        bh_cap = None
        if any_row["idealAnn"][P] is not None:
            ideal_log = math.log(1 + any_row["idealAnn"][P])
            bh_cap = math.log(1 + any_row["annBH"]) / ideal_log if ideal_log else None
        w(f"| {h} | {pct(b['annReturn'])} | {upct(b['annVol'])} | {pct(b['maxDrawdown'])} | "
          f"{upct(bh_cap)} |")
    w("")
    w("## The pick, and where it stands")
    w("")
    w(f"Chosen on train by capture at {float(P):.0%}: **{pick}**. On test it ranked "
      f"{r['testRankOfPick']} of {len(T)} pairs by the same measure.")
    w("")
    w("| pair | capture train | capture test | capture all | curve a year (train) | (test) | "
      "(all) | volatility | worst fall | switches a year |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    rows = [pick] + [k for k in r["allOrder"][:5] if k != pick] + \
           [k for k in [f"SMA 50/200", "SMA 20/50", "SMA 10/30", "EMA 12/26"] if k in T and k != pick]
    seen = set()
    for k in rows:
        if k in seen:
            continue
        seen.add(k)
        t = T[k]
        w(f"| {k}{' **(pick)**' if k == pick else ''} | {upct(t['train']['capture'][P])} | "
          f"{upct(t['test']['capture'][P])} | {upct(t['all']['capture'][P])} | "
          f"{pct(t['train']['portfolio']['annReturn'])} | {pct(t['test']['portfolio']['annReturn'])} | "
          f"{pct(t['all']['portfolio']['annReturn'])} | {upct(t['all']['portfolio']['annVol'])} | "
          f"{pct(t['all']['portfolio']['maxDrawdown'])} | {num(t['all']['switchesPerYear'], 1)} |")
    w("")
    w("Best on train by other yardsticks: " + "; ".join(
        f"{k}: {v}" for k, v in r["picks"].items() if k != "capture") + ".")
    w("")
    w("Top ten on test by capture: " + ", ".join(r["testOrder"]) + ".")
    w("")
    sb = r["stability"]
    w(f"**Does the order hold up?** Rank correlation between the train and test orderings of all "
      f"{len(T)} pairs: {sb['captureRankCorrelation']:+.2f} by capture, "
      f"{sb['curveRankCorrelation']:+.2f} by the universe curve's return, "
      f"{sb['f1RankCorrelation']:+.2f} by turn detection (below). +1 would mean the same order in "
      f"both halves, 0 no relation, negative a reversal.")
    w("")
    w(f"## Detecting the turns: hits and false alarms (turns of at least {float(P):.0%})")
    w("")
    w("A cross counts as a hit when it is the first cross after a real turn, in the right "
      "direction, before the next turn. **Precision** is hits over all crosses, **recall** hits "
      "over all turns, **F1** their harmonic mean. Chosen on train by F1: "
      f"**{r['picks']['turnF1']}**, which ranked {sb['testRankOfF1Pick']} of {len(T)} on test.")
    w("")
    w("| pair | precision | recall | F1 train | F1 test | F1 all | above the low | below the top "
      "| whipsaw per turn |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    f1_rows = [r["picks"]["turnF1"]] + sorted(
        [k for k in T if k != r["picks"]["turnF1"]],
        key=lambda k: -(T[k]["all"]["timing"][P]["f1"] or -9))[:4] + \
        [k for k in rows if k != r["picks"]["turnF1"]]
    seen = set()
    for k in f1_rows:
        if k in seen:
            continue
        seen.add(k)
        t = T[k]["all"]["timing"][P]
        w(f"| {k} | {upct(t['precision'])} | {upct(t['recall'])} | "
          f"{num(T[k]['train']['timing'][P]['f1'])} | {num(T[k]['test']['timing'][P]['f1'])} | "
          f"{num(t['f1'])} | {pct(t['entryPremium'])} | {pct(t['exitDiscount'])} | "
          f"{num(t['whipsawPerTurn'])} |")
    w("")
    w("## The speed ladder")
    w("")
    w("Every pair sits somewhere between fast (close to the turn, many false alarms) and slow "
      "(few false alarms, far from the turn). Within each band of false alarms per real turn, "
      "the pair that kept the most over the whole sample:")
    w("")
    w("| false alarms per turn | pairs in band | best pair | entry lag | above the low | "
      "exit lag | below the top | F1 | capture all | curve a year | worst fall | switches a year |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for step in r["ladder"]:
        k = step["best"]
        t = T[k]["all"]["timing"][P]
        a = T[k]["all"]
        lo_w, hi_w = step["band"]
        label = f"under {hi_w:g}" if lo_w == 0 else (f"{lo_w:g} and over" if hi_w > 50 else f"{lo_w:g} to {hi_w:g}")
        w(f"| {label} | {step['pairs']} | {k} | {days(t['entryLag'])} | {pct(t['entryPremium'])} | "
          f"{days(t['exitLag'])} | {pct(t['exitDiscount'])} | {num(t['f1'])} | {upct(a['capture'][P])} | "
          f"{pct(a['portfolio']['annReturn'])} | {pct(a['portfolio']['maxDrawdown'])} | "
          f"{num(a['switchesPerYear'], 1)} |")
    w("")
    w(f"## Timing the turns (turns of at least {float(P):.0%}, whole sample)")
    w("")
    w("| pair | valleys | held through | bought late | missed | entry lag | above the low | "
      "peaks | sat out | sold late | rode down | exit lag | below the top | whipsaw per turn |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    seen = set()
    for k in rows:
        if k in seen:
            continue
        seen.add(k)
        t = T[k]["all"]["timing"][P]
        w(f"| {k} | {t['valleys']} | {upct(t['heldThrough'])} | {upct(t['signalled'])} | "
          f"{upct(t['missed'])} | {days(t['entryLag'])} | {pct(t['entryPremium'])} | {t['peaks']} | "
          f"{upct(t['satOut'])} | {upct(t['sold'])} | {upct(t['rodeDown'])} | {days(t['exitLag'])} | "
          f"{pct(t['exitDiscount'])} | {num(t['whipsawPerTurn'])} |")
    w("")
    w("Lags and premiums above are means. Medians and upper quartiles, from a second pass over "
      "the same names:")
    w("")
    w("| pair | entry lag median (Q3) | above the low median (Q3) | exit lag median (Q3) | "
      "below the top median (Q3) | net return per name, median | held outright, median | "
      "difference, median | switches per name, median |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for k, d in r["details"].items():
        w(f"| {k} | {days(d['entryLagMedian'])} ({days(d['entryLagQ3'])}) | "
          f"{pct(d['entryPremiumMedian'])} ({pct(d['entryPremiumQ3'])}) | "
          f"{days(d['exitLagMedian'])} ({days(d['exitLagQ3'])}) | "
          f"{pct(d['exitDiscountMedian'])} ({pct(d['exitDiscountQ3'])}) | "
          f"{pct(math.exp(d['netMedianByName']) - 1)} | {pct(math.exp(d['bhMedianByName']) - 1)} | "
          f"{pct(math.exp(d['excessMedianByName']) - 1)} | {num(d['switchesMedianByName'], 0)} |")
    w("")
    w("## Does the answer depend on what counts as a turn?")
    w("")
    w("| turn size | best by capture on train | capture train | capture test | buy-and-hold "
      "capture, all | best detector on train (F1) | F1 train | F1 test | above the low | below the top |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for t in r["design"]["swings"]:
        k = r["picks"][f"capture@{t}"]
        row = T[k]
        ideal_log = math.log(1 + row["all"]["idealAnn"][str(t)])
        bh_cap = math.log(1 + row["all"]["annBH"]) / ideal_log if ideal_log else None
        kf = r["picks"][f"f1@{t}"]
        tf = T[kf]["all"]["timing"][str(t)]
        w(f"| {t:.0%} | {k} | {upct(row['train']['capture'][str(t)])} | "
          f"{upct(row['test']['capture'][str(t)])} | {upct(bh_cap)} | {kf} | "
          f"{num(T[kf]['train']['timing'][str(t)]['f1'])} | {num(T[kf]['test']['timing'][str(t)]['f1'])} | "
          f"{pct(tf['entryPremium'])} | {pct(tf['exitDiscount'])} |")
    w("")
    w("## One pair for every name, or one per name?")
    w("")
    f = r["perNameFit"]
    w(f"Fitting each name its own best pair on train, then judging on test: capture "
      f"{upct(f['fitCaptureTest'])} against {upct(f['universalCaptureTest'])} for the single "
      f"pair {pick} and {upct(f['bhCaptureTest'])} for holding outright. The per-name fit beat "
      f"the universal pair on {upct(f['shareFitBeatsUniversal'])} of names. The fitted fast "
      f"length had median {num(f['fastMedian'], 0)} (quartiles {num(f['fastQ1'], 0)} to "
      f"{num(f['fastQ3'], 0)}), the slow length median {num(f['slowMedian'], 0)} "
      f"({num(f['slowQ1'], 0)} to {num(f['slowQ3'], 0)}); "
      + ", ".join(f"{k} {v}" for k, v in sorted(f["kinds"].items())) + " names by kind.")
    w("")
    w("## Year by year: the universe curve")
    w("")
    ys = sorted(next(iter(r["years"].values())))
    w("| rule | " + " | ".join(ys) + " |")
    w("| --- | " + " | ".join("---" for _ in ys) + " |")
    for label, row in r["years"].items():
        w(f"| {label} | " + " | ".join(pct(row[y]) for y in ys) + " |")
    w("")
    w(f"## The whole grid: capture at {float(P):.0%}, whole sample")
    w("")
    w("Rows are the fast length, columns the slow. A real optimum is a ridge of similar cells; "
      "a lone bright cell is a fluke.")
    for kind in r["design"]["kinds"]:
        w("")
        w(f"### {kind}")
        w("")
        g = r["grids"][kind]["all"]
        w("| fast \\ slow | " + " | ".join(str(s) for s in r["design"]["slow"]) + " |")
        w("| --- | " + " | ".join("---" for _ in r["design"]["slow"]) + " |")
        for f_ in r["design"]["fast"]:
            cells = []
            for s in r["design"]["slow"]:
                v = g[str(f_)][str(s)]
                cells.append("" if v is None else f"{v:.0%}")
            w(f"| {f_} | " + " | ".join(cells) + " |")
    w("")
    w("### Train and test, side by side (SMA)")
    w("")
    for h in ("train", "test"):
        w("")
        w(f"**{h}**")
        w("")
        g = r["grids"]["SMA"][h]
        w("| fast \\ slow | " + " | ".join(str(s) for s in r["design"]["slow"]) + " |")
        w("| --- | " + " | ".join("---" for _ in r["design"]["slow"]) + " |")
        for f_ in r["design"]["fast"]:
            cells = []
            for s in r["design"]["slow"]:
                v = g[str(f_)][str(s)]
                cells.append("" if v is None else f"{v:.0%}")
            w(f"| {f_} | " + " | ".join(cells) + " |")
    w("")
    w("## Every pair")
    w("")
    w("| pair | capture train | capture test | capture all | per-name net a year | held outright "
      "a year | names beating hold | curve a year | volatility | worst fall | Sharpe | switches a year |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for k in sorted(T, key=lambda k: -(T[k]["all"]["capture"][P] or -9)):
        t = T[k]
        a = t["all"]
        w(f"| {k} | {upct(t['train']['capture'][P])} | {upct(t['test']['capture'][P])} | "
          f"{upct(a['capture'][P])} | {pct(a['annNet'])} | {pct(a['annBH'])} | "
          f"{upct(a['shareBeatingBH'])} | {pct(a['portfolio']['annReturn'])} | "
          f"{upct(a['portfolio']['annVol'])} | {pct(a['portfolio']['maxDrawdown'])} | "
          f"{num(a['portfolio']['sharpe'])} | {num(a['switchesPerYear'], 1)} |")
    w("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
