#!/usr/bin/env python3
"""Point-in-time backtest of the blended momentum score.

Scope: the universe ranked against itself as a whole. The within-sector basis
is a display option in the app and is not tested here — it is a different
signal and would need its own test.

Reconstructs membership month by month — the MidCap 400 from Wikipedia's
"Selected changes" table walked backwards from today, plus the S&P 500 tail
picked with the market caps that were true on the day — re-ranks the members
alive at each month end, and measures what the ranking was worth: 1/3/6 month
forward returns by decile, the top-minus-bottom spread, and how often the top
decile actually beat the bottom one.

Reuses build.py for price fetching and the momentum maths, so the backtest and
the live site cannot silently diverge.

Part of the research section (research/), not the app: it is run on demand by
the "Refresh research" workflow, not by the daily refresh, and writes to
research/data/. See research/README.md.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import re
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import build       # noqa: E402  (shared config, fetching and momentum maths)
import universes  # noqa: E402  (membership reconstruction)

# The shared loaders rewrite data/universe.json and data/sp500.json on a
# successful fetch. Research runs must not touch the published data, so use
# the fresh copy in memory and fall back to the committed file without ever
# writing it.
def _read_only_snapshot(name, fetch, describe):
    path = build.DATA / f"{name}.json"
    try:
        return fetch()
    except Exception as exc:  # noqa: BLE001
        if not path.exists():
            raise
        build.log(f"{describe}: fetch failed ({exc}); using committed snapshot")
        return json.loads(path.read_text())


build.snapshot = _read_only_snapshot
OUT = Path(__file__).resolve().parent.parent / "data"      # research/data

WIKI = build.WIKI
HORIZONS = (1, 3, 6)      # forward-return horizons, in months
DECILES = 10
MIN_MEMBERS = 400         # skip a month end whose reconstructed universe looks broken
MONTHS = 60               # ranking dates to test; the price window (6 years) sets the real floor
ADJUSTS = build.ADJUSTS   # the return itself, over its own vol, or net of the market


# --- Returns ------------------------------------------------------------------

def forward_return(series, index_map, start: str, months: int):
    """Total return from `start` to `start + months`, on adjusted closes.

    A series that ends early (acquisition, delisting) is held to its last print
    and then treated as cash — the standard conservative treatment.
    """
    dates, closes = index_map[0], index_map[1]
    i = bisect_right(dates, start) - 1
    if i < 0:
        return None
    target = add_months(start, months)
    j = bisect_right(dates, target) - 1
    if j <= i:
        # Series stopped before the horizon: hold to the final available print.
        j = len(dates) - 1
        if j <= i:
            return None
    p0, p1 = closes[i], closes[j]
    return p1 / p0 - 1.0 if p0 > 0 else None


def newey_west_t(values: list[float], lag: int) -> float:
    """t-stat for mean(values) = 0, corrected for the autocorrelation that
    overlapping forward-return windows induce."""
    n = len(values)
    mean = st.mean(values)
    resid = [v - mean for v in values]
    var = sum(v * v for v in resid) / n
    for L in range(1, lag + 1):
        cov = sum(resid[i] * resid[i - L] for i in range(L, n)) / n
        var += 2 * (1 - L / (lag + 1)) * cov
    return mean / (var / n) ** 0.5 if var > 0 else float("nan")


def plain_t(values: list[float]) -> float:
    if len(values) < 3:
        return float("nan")
    return st.mean(values) / (st.stdev(values) / len(values) ** 0.5)


def add_months(iso: str, months: int) -> str:
    y, m, d = map(int, iso.split("-"))
    m += months
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    while True:
        try:
            return dt.date(y, m, d).isoformat()
        except ValueError:
            d -= 1


# --- Main ---------------------------------------------------------------------

def main() -> None:
    log = build.log
    core_universe, core_changes = universes.load_core()
    sp500_universe, sp500_changes = universes.load_sp500()
    core_now = {c["symbol"] for c in core_universe}
    sp500_now = {c["symbol"] for c in sp500_universe}
    log(f"change logs: {len(core_changes)} MidCap 400, {len(sp500_changes)} S&P 500")

    # Every symbol that was a member at any point in the window we care about.
    horizon_start = (dt.date.today() - dt.timedelta(days=365 * build.YEARS_OF_PRICES)).isoformat()
    ever = core_now | sp500_now
    for change in core_changes + sp500_changes:
        if change["date"] >= horizon_start and change["removed"]:
            ever.add(change["removed"])
    log(f"symbols to price: {len(ever)}")

    prices = build.fetch_all_prices(sorted(ever))
    index_maps = build.make_index_maps(prices)
    calendar = build.trading_days(prices)

    # Month ends we can both rank at and measure a 6-month forward return from.
    all_month_ends = build.month_end_dates(calendar, 96)
    last_usable = add_months(calendar[-1], -max(HORIZONS))
    ranking_dates = [d for d in all_month_ends if d <= last_usable][-MONTHS:]
    log(f"{len(ranking_dates)} ranking dates, {ranking_dates[0]} → {ranking_dates[-1]}")

    # The same universe the site ranks, rebuilt at each date: the MidCap 400 as
    # it stood, plus the S&P 500 tail picked on that day's market caps.
    core_at = universes.membership_history(core_now, core_changes, ranking_dates)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, ranking_dates)
    cap_symbols = sorted({s for d in ranking_dates for s in sp500_at[d]} & set(prices))
    caps = universes.fetch_market_caps(cap_symbols)
    members_at = {
        date: (core_at[date] & set(prices))
              | universes.size_tail(sp500_at[date] & set(prices), caps, date)
        for date in ranking_dates
    }

    # adjust -> horizon -> decile -> per-month mean returns
    rows_by_h = {a: {h: defaultdict(list) for h in HORIZONS} for a in ADJUSTS}
    spreads = {a: {h: [] for h in HORIZONS} for a in ADJUSTS}
    coverage, skipped = [], 0

    for date in ranking_dates:
        members = members_at[date]
        scored = build.legs_at(members, index_maps, date)

        if len(scored) < MIN_MEMBERS:
            skipped += 1
            continue
        coverage.append((len(members), len(scored)))

        # One forward-return lookup per name serves every decile of every
        # variant, so cache it rather than re-walking the price series.
        fwd = {h: {s: forward_return(prices[s], index_maps[s], date, h) for s in scored}
               for h in HORIZONS}

        for adjust in ADJUSTS:
            at = build.LEG_VALUE[adjust]
            p12 = build.percentiles({s: v[0][at] for s, v in scored.items()})
            p6 = build.percentiles({s: v[1][at] for s, v in scored.items()})
            blended = {s: 0.5 * p12[s] + 0.5 * p6[s] for s in scored}
            order = sorted(blended, key=lambda s: (-blended[s], s))   # ties: see rank_block
            size = len(order) // DECILES

            for h in HORIZONS:
                means = []
                for d in range(DECILES):
                    bucket = (order[d * size : (d + 1) * size] if d < DECILES - 1
                              else order[d * size :])
                    rets = [r for r in (fwd[h][s] for s in bucket) if r is not None]
                    if not rets:
                        means.append(None)
                        continue
                    mean = st.mean(rets)
                    rows_by_h[adjust][h][d].append(mean)
                    means.append(mean)
                if means[0] is not None and means[-1] is not None:
                    spreads[adjust][h].append((date, means[0] - means[-1]))

    log(f"used {len(coverage)} month ends (skipped {skipped}); "
        f"median members {st.median(m for m, _ in coverage):.0f}, "
        f"median scored {st.median(s for _, s in coverage):.0f}")

    report = {
        "rankingDates": len(coverage),
        "from": ranking_dates[0],
        "to": ranking_dates[-1],
        "variants": {},
    }
    for adjust in ADJUSTS:
        variant = {}
        label = {"raw": "return", "vol": "return / volatility", "resid": "return net of market"}[adjust]
        print()
        print(f"########## RANKED ON {label.upper()} ##########")
        for h in HORIZONS:
            sp = [s for _, s in spreads[adjust][h]]
            print()
            print(f"=== {h}-MONTH FORWARD RETURNS, equal-weighted, {len(sp)} month ends ===")
            print("  decile   mean     median     win rate   n")
            decile_stats = []
            for d in range(DECILES):
                v = rows_by_h[adjust][h][d]
                row = {
                    "decile": d + 1,
                    "mean": st.mean(v),
                    "median": st.median(v),
                    "winRate": sum(1 for x in v if x > 0) / len(v),
                    "n": len(v),
                }
                decile_stats.append(row)
                name = "D1 (top)" if d == 0 else "D10 (bot)" if d == 9 else f"D{d + 1}"
                print(f"  {name:>9} {row['mean']:+7.2%}  {row['median']:+7.2%}   "
                      f"{row['winRate']:6.0%}   {row['n']}")
            hit = sum(1 for x in sp if x > 0) / len(sp)
            # Sampling h-month returns every month makes windows overlap, which
            # inflates a plain t-stat. Report both corrections instead.
            independent = sp[::h]
            by_year = defaultdict(list)
            for date, spread in spreads[adjust][h]:
                by_year[date[:4]].append(spread)
            print(f"  TOP-MINUS-BOTTOM  mean {st.mean(sp):+.2%}  median {st.median(sp):+.2%}  "
                  f"hit rate {hit:.0%}")
            print(f"  t: naive {plain_t(sp):.2f} | Newey-West {newey_west_t(sp, max(1, h - 1)):.2f} | "
                  f"non-overlapping {plain_t(independent):.2f} (n={len(independent)})")
            print(f"  best {max(sp):+.1%}  worst {min(sp):+.1%}")
            variant[h] = {
                "deciles": decile_stats,
                "spread": {
                    "mean": st.mean(sp), "median": st.median(sp), "hitRate": hit,
                    "tNaive": plain_t(sp),
                    "tNeweyWest": newey_west_t(sp, max(1, h - 1)),
                    "tIndependent": plain_t(independent),
                    "nIndependent": len(independent),
                    "best": max(sp), "worst": min(sp),
                    "byYear": [{"year": y, "mean": st.mean(v), "n": len(v),
                                "hitRate": sum(1 for x in v if x > 0) / len(v)}
                               for y, v in sorted(by_year.items())],
                    "series": [{"date": d, "spread": x} for d, x in spreads[adjust][h]],
                },
            }
        report["variants"][adjust] = {"horizons": variant}
    print()

    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / "backtest.json"
    out.write_text(json.dumps(report, separators=(",", ":")) + "\n")
    build.log(f"wrote {out.name}")


if __name__ == "__main__":
    main()
