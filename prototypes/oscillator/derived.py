#!/usr/bin/env python3
"""Prototype: an oscillator derived from this universe's own data, not borrowed
from a chart package.

Companion to oscillator.py, which tested the textbook oscillators (RSI, the
stochastic, Bollinger bands) and found none of them predicts anything at the
stock level. This script does not assume any formula. It measures a name's
recent behaviour in raw terms, lets the data say which of those measures
mattered for the month that followed, and builds the reading out of that.

What "derived from the data" means here
---------------------------------------
1. Descriptors. At every week end, for every member, sixteen plain readings of
   its own recent history, each in units the data itself sets (the name's own
   volatility, its own range, its own volume):
     stretch_k     return over the last k trading days divided by the daily
                   volatility of that window times sqrt(k) - "how many sigmas
                   has it moved" - for k = 5, 10, 21, 42, 63, 126, 252
     range63/252   where the close sits in its 63- / 252-day high-low range
     drawdown      close relative to its 252-day high
     volregime     21-day volatility over 126-day volatility
     jumpup/down   the biggest up / down day of the last 21, in sigmas
     closepos      where closes sat inside each day's high-low range, 21-day mean
     volshock      5-day mean volume over 63-day mean volume, as a log
     voltrend      21-day mean volume over 126-day mean volume, as a log
   None of these is an oscillator. They are the raw material.
2. Fit. Each week, rank every descriptor across the universe and regress the
   rank of the forward one-month return on those ranks (Fama-MacBeth: one
   cross-sectional regression per week, coefficients averaged over weeks, with
   the overlap-corrected t-statistic). The averaged coefficients are the
   oscillator's weights. The sign and size of each weight is the finding:
   which horizons the universe rewards and which it punishes.
3. Reading. The weighted sum of a name's descriptor ranks, expressed as its
   percentile against the universe that day: 0 to 100, bounded, mean-reverting,
   an oscillator in the plain sense.
4. Proof. Weights are fitted on the first half of the sample only and judged
   on the second half; then refitted walk-forward every quarter using only
   weeks whose outcome was already known, which is the closest thing to how it
   would have been used. A sparse version keeps only the descriptors whose
   weight was clearly non-zero in training, to guard against fitting noise.
5. Universe level. The same descriptors aggregated across members (medians,
   shares past a threshold, dispersion) are tested as readings for the
   universe as a whole, with bands set from the training half's own
   distribution rather than by hand.

Not part of the site. Writes results-derived.json and DERIVED.md beside
itself and nothing else. Standard library only.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict, deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import oscillator as base   # noqa: E402  (data loading, statistics, read-only snapshot guard)
import build                # noqa: E402

HORIZONS = base.HORIZONS
PRIMARY = "1m"
WARMUP = 260                 # 252-day descriptors plus slack
MIN_MEMBERS = base.MIN_MEMBERS
DECILES = 10
LEAD = 5                     # weeks between the last training week and the week scored (1m outcome must be known)
FIRST_FIT = 78               # weeks of history before the first walk-forward fit
REFIT_EVERY = 13             # walk-forward refit cadence, in weeks
SPARSE_T = 2.0               # |t| a descriptor needs in training to enter the sparse model
UNIVERSE_TOP = 3             # universe descriptors kept for the combined reading, by train |t|

STRETCH = (5, 10, 21, 42, 63, 126, 252)
FEATURES = ([f"stretch_{k}" for k in STRETCH]
            + ["range63", "range252", "drawdown", "volregime", "jumpup", "jumpdown",
               "closepos", "volshock", "voltrend"])

log = base.log


# --- Descriptors --------------------------------------------------------------

def rolling_extreme(values, n, biggest):
    """Rolling max (or min) over the trailing n values, O(T) with a deque."""
    out = [None] * len(values)
    dq = deque()
    for i, v in enumerate(values):
        while dq and (values[dq[-1]] <= v if biggest else values[dq[-1]] >= v):
            dq.pop()
        dq.append(i)
        if dq[0] <= i - n:
            dq.popleft()
        if i >= n - 1:
            out[i] = values[dq[0]]
    return out


def rolling_mean(values, n):
    out = [None] * len(values)
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def rolling_sd(values, n):
    out = [None] * len(values)
    s = s2 = 0.0
    for i, v in enumerate(values):
        s += v
        s2 += v * v
        if i >= n:
            s -= values[i - n]
            s2 -= values[i - n] ** 2
        if i >= n - 1:
            m = s / n
            out[i] = math.sqrt(max(s2 / n - m * m, 0.0))
    return out


def descriptors(closes, highs, lows, volumes):
    """Per-day descriptor arrays for one name. None until warmed up."""
    T = len(closes)
    r = [0.0] + [math.log(closes[i] / closes[i - 1]) if closes[i] > 0 and closes[i - 1] > 0 else 0.0
                 for i in range(1, T)]
    # Log volume, with the odd missing or zero print carried forward from the
    # day before so one bad row does not disqualify a name from the study.
    lv, last = [], None
    for v in volumes:
        if v and v > 0:
            last = math.log(v)
        lv.append(last)
    out = {}
    sd = {n: rolling_sd(r, n) for n in set(STRETCH) | {21, 126}}
    for k in STRETCH:
        arr = [None] * T
        for i in range(k, T):
            s = sd[k][i]
            if s and s > 1e-9 and closes[i - k] > 0:
                arr[i] = math.log(closes[i] / closes[i - k]) / (s * math.sqrt(k))
        out[f"stretch_{k}"] = arr
    for n, name in ((63, "range63"), (252, "range252")):
        hi, lo = rolling_extreme(highs, n, True), rolling_extreme(lows, n, False)
        out[name] = [None if hi[i] is None or hi[i] <= lo[i] else (closes[i] - lo[i]) / (hi[i] - lo[i])
                     for i in range(T)]
    hi252 = rolling_extreme(highs, 252, True)
    out["drawdown"] = [None if h is None or h <= 0 else closes[i] / h - 1.0 for i, h in enumerate(hi252)]
    out["volregime"] = [None if sd[21][i] is None or not sd[126][i] else sd[21][i] / sd[126][i]
                        for i in range(T)]
    mx, mn = rolling_extreme(r, 21, True), rolling_extreme(r, 21, False)
    out["jumpup"] = [None if mx[i] is None or not sd[21][i] else mx[i] / sd[21][i] for i in range(T)]
    out["jumpdown"] = [None if mn[i] is None or not sd[21][i] else mn[i] / sd[21][i] for i in range(T)]
    pos = [0.5 if highs[i] <= lows[i] else (closes[i] - lows[i]) / (highs[i] - lows[i]) for i in range(T)]
    out["closepos"] = rolling_mean(pos, 21)
    if lv and lv[-1] is not None and sum(v is None for v in lv) < 10:
        lv = [v if v is not None else lv[-1] for v in lv]
        v5, v21, v63, v126 = (rolling_mean(lv, n) for n in (5, 21, 63, 126))
        out["volshock"] = [None if v63[i] is None else v5[i] - v63[i] for i in range(T)]
        out["voltrend"] = [None if v126[i] is None else v21[i] - v126[i] for i in range(T)]
    else:
        out["volshock"] = out["voltrend"] = [None] * T
    return out


# --- Linear algebra, small and plain -----------------------------------------

def solve(A, b):
    """Gaussian elimination with partial pivoting. A is n x n, b length n."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r_: abs(M[r_][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r_ in range(c + 1, n):
            f = M[r_][c] / M[c][c]
            if f:
                for k in range(c, n + 1):
                    M[r_][k] -= f * M[c][k]
    x = [0.0] * n
    for c in range(n - 1, -1, -1):
        s = M[c][n] - sum(M[c][k] * x[k] for k in range(c + 1, n))
        x[c] = s / M[c][c] if abs(M[c][c]) >= 1e-12 else 0.0
    return x


def ols(X, y, ridge=1e-6):
    """Coefficients of y on X (rows = names, columns = features, intercept added)."""
    n, p = len(X), len(X[0])
    cols = p + 1
    XtX = [[0.0] * cols for _ in range(cols)]
    Xty = [0.0] * cols
    for row, yy in zip(X, y):
        xr = row + [1.0]
        for i in range(cols):
            xi = xr[i]
            if xi == 0.0:
                continue
            Xty[i] += xi * yy
            Xi = XtX[i]
            for j in range(cols):
                Xi[j] += xi * xr[j]
    for i in range(p):
        XtX[i][i] += ridge * n
    return solve(XtX, Xty)[:p]


def centred_ranks(values):
    """Average ranks scaled to [-0.5, 0.5]."""
    rk = base.ranks(values)
    n = len(values)
    return [r / (n - 1) - 0.5 for r in rk] if n > 1 else [0.0] * n


# --- Main ---------------------------------------------------------------------

def main() -> None:
    prices, calendar, members_at, note = base.load_prices()
    log(note)
    index = {d: i for i, d in enumerate(calendar)}
    start = build.price_start()

    # Highs, lows and volume come from the same cached vendor payload the
    # closes did; the offline preview has bars but no volume.
    log("descriptors")
    desc = {}
    for symbol, (dates, closes) in prices.items():
        highs, lows, volumes = closes, closes, [None] * len(closes)
        if base.ONLINE:
            rows = {r["date"]: r for r in build.cached_fmp(
                f"px-{symbol}", "historical-price-eod/dividend-adjusted", symbol=symbol, **{"from": start})
                if isinstance(r, dict)}
            highs = [float(rows[d].get("adjHigh") or c) for d, c in zip(dates, closes)]
            lows = [float(rows[d].get("adjLow") or c) for d, c in zip(dates, closes)]
            volumes = [rows[d].get("volume") for d in dates]
        else:
            bars = json.loads((base.DATA / "bars" / f"{symbol}.json").read_text())
            by = {d: (h, l) for d, h, l in zip(bars["dates"], bars["h"], bars["l"])}
            highs = [float(by[d][0]) if d in by else c for d, c in zip(dates, closes)]
            lows = [float(by[d][1]) if d in by else c for d, c in zip(dates, closes)]
        desc[symbol] = descriptors(closes, highs, lows, volumes)
    has_volume = any(any(v is not None for v in d["volshock"]) for d in desc.values())
    features = FEATURES if has_volume else [f for f in FEATURES if not f.startswith("vol") or f == "volregime"]
    log(f"{len(features)} descriptors ({'with' if has_volume else 'without'} volume)")

    week_ends = build.week_end_dates(calendar, 10_000)
    last_h = HORIZONS["3m"]
    eval_dates = [d for d in week_ends if index[d] >= WARMUP and index[d] + last_h < len(calendar)]

    # --- Per week: descriptor ranks, forward returns, the momentum score ---
    weeks = []          # dicts: date, symbols, X (ranks), fwd {h: list}, score list
    uni = []            # universe-level descriptor readings and EW forward returns
    for date in eval_dates:
        ci = index[date]
        rows = {}
        for symbol in members_at(date):
            entry = prices.get(symbol)
            if not entry:
                continue
            dates, closes = entry
            pos = bisect_right(dates, date) - 1
            if pos < WARMUP or dates[pos] != date:
                continue
            vals = [desc[symbol][f][pos] for f in features]
            if any(v is None for v in vals):
                continue
            fwd = {}
            for h, days in HORIZONS.items():
                j = bisect_right(dates, calendar[ci + days]) - 1
                if j <= pos:
                    j = len(dates) - 1
                fwd[h] = closes[j] / closes[pos] - 1.0
            rows[symbol] = (vals, fwd)
        if len(rows) < MIN_MEMBERS:
            continue
        symbols = sorted(rows)
        cols = [centred_ranks([rows[s][0][k] for s in symbols]) for k in range(len(features))]
        X = [[cols[k][i] for k in range(len(features))] for i in range(len(symbols))]
        legs = build.legs_at(set(symbols), prices, date)
        p12 = build.percentiles({s: v[0][0] for s, v in legs.items()})
        p6 = build.percentiles({s: v[1][0] for s, v in legs.items()})
        score = [0.5 * p12[s] + 0.5 * p6[s] if s in legs else None for s in symbols]
        weeks.append({
            "date": date, "symbols": symbols, "X": X,
            "fwd": {h: [rows[s][1][h] for s in symbols] for h in HORIZONS},
            "score": score,
        })
        # Universe readings: aggregate the raw descriptors, not the ranks.
        raw = {f: [rows[s][0][k] for s in symbols] for k, f in enumerate(features)}
        s21 = sorted(raw["stretch_21"])
        q = lambda arr, p: arr[int(p * (len(arr) - 1))]      # noqa: E731
        uni.append({
            "date": date,
            "reading": {
                "median_stretch_21": st.median(raw["stretch_21"]),
                "median_stretch_63": st.median(raw["stretch_63"]),
                "share_capitulating": sum(1 for v in raw["stretch_21"] if v < -2) / len(symbols),
                "share_near_lows": sum(1 for v in raw["range252"] if v < 0.1) / len(symbols),
                "share_near_highs": sum(1 for v in raw["range252"] if v > 0.9) / len(symbols),
                "median_drawdown": st.median(raw["drawdown"]),
                "dispersion_21": q(s21, 0.75) - q(s21, 0.25),
                "median_volregime": st.median(raw["volregime"]),
                "median_closepos": st.median(raw["closepos"]),
                **({"median_volshock": st.median(raw["volshock"])} if has_volume else {}),
            },
            "ew": {h: st.fmean(rows[s][1][h] for s in symbols) for h in HORIZONS},
        })
        if len(weeks) % 25 == 0:
            log(f"  {len(weeks)} week ends ({date})")
    log(f"{len(weeks)} week ends used, {weeks[0]['date']} to {weeks[-1]['date']}")
    split_i = len(weeks) // 2
    split = weeks[split_i]["date"]
    lag_of = {h: max(1, math.ceil(days / 5) - 1) for h, days in HORIZONS.items()}

    # --- Fama-MacBeth on the training half ---
    def fit(week_slice, cols_idx):
        betas = []
        for wk in week_slice:
            X = [[row[k] for k in cols_idx] for row in wk["X"]]
            y = centred_ranks(wk["fwd"][PRIMARY])
            betas.append(ols(X, y))
        mean = [st.fmean(b[k] for b in betas) for k in range(len(cols_idx))]
        tstat = [base.newey_west_t([b[k] for b in betas], lag_of[PRIMARY]) for k in range(len(cols_idx))]
        return mean, tstat

    all_idx = list(range(len(features)))
    beta_full, t_full = fit(weeks[:split_i], all_idx)
    sparse_idx = [k for k in all_idx if abs(t_full[k]) >= SPARSE_T]
    beta_sparse, t_sparse = fit(weeks[:split_i], sparse_idx) if sparse_idx else ([], [])
    log("training weights: " + ", ".join(f"{features[k]} {beta_full[k]:+.3f} (t {t_full[k]:+.1f})"
                                          for k in all_idx))
    log("sparse keeps: " + (", ".join(features[k] for k in sparse_idx) or "nothing"))

    # Single-descriptor ICs, so the reader sees what the data liked on its own.
    single = {}
    for k, f in enumerate(features):
        single[f] = {}
        for h in HORIZONS:
            series = []
            for wk in weeks:
                r = base.spearman([row[k] for row in wk["X"]], wk["fwd"][h])
                if r is not None:
                    series.append((wk["date"], r))
            single[f][h] = {
                "all": base.summarise(series, lag_of[h]),
                "train": base.summarise([s for s in series if s[0] < split], lag_of[h]),
                "test": base.summarise([s for s in series if s[0] >= split], lag_of[h]),
            }

    # --- Score every week with fixed weights (train-fitted) and walk-forward ---
    def score_week(wk, cols_idx, beta):
        return [sum(row[k] * b for k, b in zip(cols_idx, beta)) for row in wk["X"]]

    def evaluate(name, scorer):
        """scorer(i, wk) -> list of readings or None. Returns IC blocks, deciles, by-year."""
        ic = {h: [] for h in HORIZONS}
        dec = {h: [] for h in HORIZONS}
        for i, wk in enumerate(weeks):
            reading = scorer(i, wk)
            if reading is None:
                continue
            for h in HORIZONS:
                r = base.spearman(reading, wk["fwd"][h])
                if r is not None:
                    ic[h].append((wk["date"], r))
                    dec[h].append(base.bucket_means(reading, wk["fwd"][h], DECILES))
        out = {}
        for h in HORIZONS:
            block = {
                "all": base.summarise(ic[h], lag_of[h]),
                "train": base.summarise([s for s in ic[h] if s[0] < split], lag_of[h]),
                "test": base.summarise([s for s in ic[h] if s[0] >= split], lag_of[h]),
                "byYear": base.by_year(ic[h]),
            }
            if dec[h]:
                block["deciles"] = [st.fmean(d[j] for d in dec[h]) for j in range(DECILES)]
                block["spreadTopMinusBottom"] = block["deciles"][-1] - block["deciles"][0]
            out[h] = block
        return out

    momentum = evaluate("momentum", lambda i, wk: None if any(v is None for v in wk["score"]) else wk["score"])
    full = evaluate("full", lambda i, wk: score_week(wk, all_idx, beta_full))
    sparse = evaluate("sparse", (lambda i, wk: score_week(wk, sparse_idx, beta_sparse)) if sparse_idx
                      else (lambda i, wk: None))

    # Walk-forward: refit every REFIT_EVERY weeks on weeks whose 1m outcome was known.
    wf_beta = {}
    wf_idx = {}
    def walk(i, wk, sparse_mode):
        if i < FIRST_FIT:
            return None
        key = (i - FIRST_FIT) // REFIT_EVERY
        if key not in wf_beta:
            train = weeks[: i - LEAD]
            b, t = fit(train, all_idx)
            keep = [k for k in all_idx if abs(t[k]) >= SPARSE_T] or all_idx
            bs, _ = fit(train, keep)
            wf_beta[key] = (b, bs)
            wf_idx[key] = keep
        b, bs = wf_beta[key]
        return score_week(wk, wf_idx[key], bs) if sparse_mode else score_week(wk, all_idx, b)
    walk_full = evaluate("walk_full", lambda i, wk: walk(i, wk, False))
    walk_sparse = evaluate("walk_sparse", lambda i, wk: walk(i, wk, True))
    walk_from = weeks[FIRST_FIT]["date"]
    momentum_walk = evaluate("momentum_walk", lambda i, wk: None if i < FIRST_FIT or any(v is None for v in wk["score"]) else wk["score"])

    # Current reading: the latest week end scored with the last walk-forward sparse weights.
    last_key = max(wf_idx)
    latest = weeks[-1]
    latest_reading = score_week(latest, wf_idx[last_key], wf_beta[last_key][1])
    latest_pct = build.percentiles(dict(zip(latest["symbols"], latest_reading)))
    latest_weights = {features[k]: round(b, 4) for k, b in zip(wf_idx[last_key], wf_beta[last_key][1])}

    # --- Universe level ---
    uni_names = list(uni[0]["reading"])
    uni_out = {}
    train_u = [u for u in uni if u["date"] < split]
    for name in uni_names:
        x_all = [u["reading"][name] for u in uni]
        per_h = {}
        for h in HORIZONS:
            y_all = [u["ew"][h] for u in uni]
            first = [(u["reading"][name], u["ew"][h]) for u in uni if u["date"] < split]
            second = [(u["reading"][name], u["ew"][h]) for u in uni if u["date"] >= split]
            per_h[h] = {
                "spearman": base.spearman(x_all, y_all),
                "spearmanTrain": base.spearman([a for a, _ in first], [b for _, b in first]),
                "spearmanTest": base.spearman([a for a, _ in second], [b for _, b in second]),
                "slopeT": base.newey_west_slope_t(x_all, y_all, lag_of[h]),
                "n": len(x_all),
            }
        # Bands from the training half's own distribution: outer tenths.
        tr = sorted(u["reading"][name] for u in train_u)
        lo_band, hi_band = tr[int(0.1 * (len(tr) - 1))], tr[int(0.9 * (len(tr) - 1))]
        pts = [(u["date"], u["reading"][name], u["ew"]) for u in uni]
        lo_w = [p[2] for p in pts if p[1] < lo_band]
        hi_w = [p[2] for p in pts if p[1] > hi_band]
        mid_w = [p[2] for p in pts if lo_band <= p[1] <= hi_band]
        uni_out[name] = {
            "latest": uni[-1]["reading"][name],
            "bands": [lo_band, hi_band],
            "horizons": per_h,
            "buckets": {h: {
                "low": {"n": len(lo_w), "mean": st.fmean(w[h] for w in lo_w) if lo_w else None},
                "middle": {"n": len(mid_w), "mean": st.fmean(w[h] for w in mid_w) if mid_w else None},
                "high": {"n": len(hi_w), "mean": st.fmean(w[h] for w in hi_w) if hi_w else None},
            } for h in HORIZONS},
            "lowEpisodes": base.episodes(pts, below=lo_band),
            "highEpisodes": base.episodes(pts, above=hi_band),
        }
    # A combined universe reading: the top few by training |t| at 1m, each turned
    # into a percentile against the training distribution and sign-aligned so
    # that high = "expect more", then averaged.
    ranked_u = sorted(uni_names, key=lambda n_: -abs(uni_out[n_]["horizons"][PRIMARY]["slopeT"] or 0))
    chosen = ranked_u[:UNIVERSE_TOP]
    train_sorted = {n_: sorted(u["reading"][n_] for u in train_u) for n_ in chosen}
    sign = {n_: 1 if (uni_out[n_]["horizons"][PRIMARY]["spearmanTrain"] or 0) > 0 else -1 for n_ in chosen}
    def combined(u):
        parts = []
        for n_ in chosen:
            arr = train_sorted[n_]
            pct = bisect_right(arr, u["reading"][n_]) / len(arr)
            parts.append(pct if sign[n_] > 0 else 1 - pct)
        return st.fmean(parts)
    comb = [(u["date"], combined(u), u["ew"]) for u in uni]
    comb_out = {"parts": {n_: sign[n_] for n_ in chosen}, "horizons": {}, "latest": comb[-1][1]}
    for h in HORIZONS:
        x = [c[1] for c in comb]; y = [c[2][h] for c in comb]
        first = [c for c in comb if c[0] < split]; second = [c for c in comb if c[0] >= split]
        comb_out["horizons"][h] = {
            "spearman": base.spearman(x, y),
            "spearmanTrain": base.spearman([c[1] for c in first], [c[2][h] for c in first]),
            "spearmanTest": base.spearman([c[1] for c in second], [c[2][h] for c in second]),
            "slopeT": base.newey_west_slope_t(x, y, lag_of[h]),
            "top": st.fmean(c[2][h] for c in comb if c[1] > 0.8),
            "bottom": st.fmean(c[2][h] for c in comb if c[1] < 0.2),
            "nTop": sum(1 for c in comb if c[1] > 0.8), "nBottom": sum(1 for c in comb if c[1] < 0.2),
        }
    comb_out["highEpisodes"] = base.episodes(comb, above=0.8)
    comb_out["lowEpisodes"] = base.episodes(comb, below=0.2)

    results = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "online-six-year" if base.ONLINE else "offline-preview",
        "note": note,
        "weekEnds": len(weeks), "from": weeks[0]["date"], "to": weeks[-1]["date"], "split": split,
        "walkForwardFrom": walk_from,
        "features": features,
        "trainWeights": {f: {"beta": beta_full[k], "t": t_full[k]} for k, f in enumerate(features)},
        "sparseFeatures": [features[k] for k in sparse_idx],
        "sparseWeights": {features[k]: {"beta": b, "t": t} for k, b, t in zip(sparse_idx, beta_sparse, t_sparse)},
        "single": single,
        "momentum": momentum, "momentumWalk": momentum_walk,
        "full": full, "sparse": sparse, "walkFull": walk_full, "walkSparse": walk_sparse,
        "latest": {
            "date": latest["date"], "weights": latest_weights,
            "top": sorted(latest_pct, key=lambda s: -latest_pct[s])[:15],
            "bottom": sorted(latest_pct, key=lambda s: latest_pct[s])[:15],
            "readings": {s: round(v, 1) for s, v in latest_pct.items()},
        },
        "universe": uni_out,
        "universeCombined": comb_out,
        "universeSeries": {"dates": [u["date"] for u in uni],
                           "combined": [round(c[1], 4) for c in comb],
                           **{n_: [round(u["reading"][n_], 4) for u in uni] for n_ in chosen}},
    }
    (HERE / "results-derived.json").write_text(json.dumps(results, separators=(",", ":")) + "\n")
    (HERE / "DERIVED.md").write_text(report(results))
    log("wrote results-derived.json and DERIVED.md")
    print()
    print(report(results))


# --- Report -------------------------------------------------------------------

pct, num = base.pct, base.num


def report(r: dict) -> str:
    lines = []
    w = lines.append
    w("# Derived oscillator: results")
    w("")
    w(f"Generated {r['generatedAt'][:10]}. Mode: **{r['mode']}**.")
    w("")
    w(r["note"])
    w("")
    w(f"{r['weekEnds']} week ends from {r['from']} to {r['to']}. Weights fitted on weeks before "
      f"{r['split']} (train), judged from then on (test). Walk-forward readings start "
      f"{r['walkForwardFrom']} and are refitted every {REFIT_EVERY} weeks on outcomes already known.")
    w("")
    w("## What the data weighted")
    w("")
    w("Coefficients of the forward one-month return rank on each descriptor's rank, averaged over "
      "the training weeks (Fama-MacBeth). Positive: names high on this reading went on to do better. "
      f"|t| of {SPARSE_T:.0f} or more is the bar for the sparse model.")
    w("")
    w("| descriptor | weight | t | in sparse | own IC 1m train | own IC 1m test | own IC 3m all |")
    w("| --- | --- | --- | --- | --- | --- | --- |")
    for f in r["features"]:
        tw = r["trainWeights"][f]
        s = r["single"][f]
        w(f"| {f} | {num(tw['beta'])} | {num(tw['t'], 1)} | {'yes' if f in r['sparseFeatures'] else ''} | "
          f"{num(s['1m']['train']['meanIC'])} | {num(s['1m']['test']['meanIC'])} | {num(s['3m']['all']['meanIC'])} |")
    w("")
    w("## The oscillator against the momentum score")
    w("")
    w("IC = rank correlation between the reading and the return that followed, averaged over "
      "week ends; t with the overlap correction. D10−D1 = mean forward return of the top tenth of "
      "readings minus the bottom tenth.")
    w("")
    w("| reading | horizon | IC train | IC test | t test | IC all | t all | D10−D1 (all) |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for label, key in (("momentum score (site)", "momentum"), ("derived, all descriptors", "full"),
                       ("derived, sparse", "sparse")):
        for h in HORIZONS:
            b = r[key].get(h)
            if not b:
                continue
            w(f"| {label} | {h} | {num(b['train']['meanIC'])} | {num(b['test']['meanIC'])} | "
              f"{num(b['test']['t'], 1)} | {num(b['all']['meanIC'])} | {num(b['all']['t'], 1)} | "
              f"{pct(b.get('spreadTopMinusBottom'))} |")
    w("")
    w(f"## Walk-forward (from {r['walkForwardFrom']}, weights only ever from the past)")
    w("")
    w("| reading | horizon | IC | t | D10−D1 | " + " | ".join(sorted({y for h in HORIZONS for y in r['walkSparse'][h]['byYear']})) + " |")
    years = sorted({y for h in HORIZONS for y in r["walkSparse"][h]["byYear"]})
    w("| --- | --- | --- | --- | --- | " + " | ".join("---" for _ in years) + " |")
    for label, key in (("momentum score (site)", "momentumWalk"), ("derived, all", "walkFull"),
                       ("derived, sparse", "walkSparse")):
        for h in HORIZONS:
            b = r[key][h]
            by = b["byYear"]
            w(f"| {label} | {h} | {num(b['all']['meanIC'])} | {num(b['all']['t'], 1)} | "
              f"{pct(b.get('spreadTopMinusBottom'))} | "
              + " | ".join(num(by[y]["meanIC"]) if y in by else "n/a" for y in years) + " |")
    w("")
    w("## Deciles of the walk-forward sparse reading (mean forward return, lowest tenth to highest)")
    w("")
    w("| horizon | " + " | ".join(f"D{i + 1}" for i in range(DECILES)) + " |")
    w("| --- | " + " | ".join("---" for _ in range(DECILES)) + " |")
    for h in HORIZONS:
        d = r["walkSparse"][h].get("deciles")
        if d:
            w(f"| {h} | " + " | ".join(pct(v, 1) for v in d) + " |")
    w("")
    w(f"## The reading today ({r['latest']['date']})")
    w("")
    w("Weights in use: " + ", ".join(f"{k} {v:+.3f}" for k, v in r["latest"]["weights"].items()) + ".")
    w("")
    w("Highest readings: " + ", ".join(f"{s} ({r['latest']['readings'][s]:.0f})" for s in r["latest"]["top"]) + ".")
    w("")
    w("Lowest readings: " + ", ".join(f"{s} ({r['latest']['readings'][s]:.0f})" for s in r["latest"]["bottom"]) + ".")
    w("")
    w("## Universe-level readings derived from the same descriptors")
    w("")
    w("Each aggregate against the equal-weight universe's forward return. Bands are the outer "
      "tenths of the training half's own readings, not hand-set. corr over the whole sample "
      "(train | test), t with the overlap correction, then mean forward return below the low band, "
      "between, and above the high band, with week counts.")
    w("")
    w("| reading | latest | bands | horizon | corr | train | test | t | low (wks) | middle (wks) | high (wks) |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for name, u in r["universe"].items():
        for h in ("1m", "3m"):
            v = u["horizons"][h]; b = u["buckets"][h]
            w(f"| {name} | {u['latest']:+.3f} | {u['bands'][0]:+.3f} / {u['bands'][1]:+.3f} | {h} | "
              f"{num(v['spearman'], 2)} | {num(v['spearmanTrain'], 2)} | {num(v['spearmanTest'], 2)} | "
              f"{num(v['slopeT'], 1)} | {pct(b['low']['mean'])} ({b['low']['n']}) | "
              f"{pct(b['middle']['mean'])} ({b['middle']['n']}) | {pct(b['high']['mean'])} ({b['high']['n']}) |")
    w("")
    c = r["universeCombined"]
    parts = ", ".join(f"{k} ({'+' if s_ > 0 else '-'})" for k, s_ in c["parts"].items())
    w(f"### Combined universe reading: {parts}")
    w("")
    w(f"The top {UNIVERSE_TOP} aggregates by training t, each as a percentile of the training "
      f"distribution, sign-aligned so high means \"expect more\", averaged. Latest {c['latest']:.0%}.")
    w("")
    w("| horizon | corr | train | test | t | reading > 80% (wks) | reading < 20% (wks) |")
    w("| --- | --- | --- | --- | --- | --- | --- |")
    for h, v in c["horizons"].items():
        w(f"| {h} | {num(v['spearman'], 2)} | {num(v['spearmanTrain'], 2)} | {num(v['spearmanTest'], 2)} | "
          f"{num(v['slopeT'], 1)} | {pct(v['top'])} ({v['nTop']}) | {pct(v['bottom'])} ({v['nBottom']}) |")
    w("")
    for label, key in (("Reading above 80% (\"expect more\")", "highEpisodes"),
                       ("Reading below 20% (\"expect less\")", "lowEpisodes")):
        eps = c[key]
        w(f"**{label}**, {len(eps)} spells, measured from the first week end of each")
        w("")
        w("| first week end | weeks | next 1m | next 3m |")
        w("| --- | --- | --- | --- |")
        for e in eps:
            w(f"| {e['start']} | {e['weeks']} | {pct(e['fwd1m'], 1)} | {pct(e['fwd3m'], 1)} |")
        if eps:
            w(f"| **mean** | | {pct(st.fmean(e['fwd1m'] for e in eps), 1)} | {pct(st.fmean(e['fwd3m'] for e in eps), 1)} |")
            w(f"| **positive** | | {sum(1 for e in eps if e['fwd1m'] > 0)}/{len(eps)} | "
              f"{sum(1 for e in eps if e['fwd3m'] > 0)}/{len(eps)} |")
        w("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
