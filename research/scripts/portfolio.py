#!/usr/bin/env python3
"""What holding the top decile would have done, day by day.

The decile table in backtest.py answers "does the ordering work". This answers
the question a holder actually asks: if I had bought the top decile equally
weighted and rebalanced monthly, what would the account have done, and how
rough would the ride have been.

Construction, deliberately plain:

* **Universe** — point-in-time, the same ~650-name membership reconstruction
  the live site ranks with.
* **Rebalance** — monthly, at each month end, on that day's cross-section.
* **Weights** — equal at each rebalance, then left alone. No daily rebalancing,
  because that would assume trading the app never asks you to do.
* **Dropouts** — a name that stops pricing (acquired, delisted) is held at its
  last print and left there until the next rebalance, the conservative
  treatment backtest.py already uses.
* **Costs** — none. No commissions, spreads, slippage or tax. Every figure here
  is therefore better than the same strategy would have been in an account.

Ranked every way the app offers — on the return itself, on the return over its
own volatility, and on the return net of the market — because the reader can
choose, and the evidence should follow whichever they picked.

Part of the research section (research/), not the app: run on demand by the
"Refresh research" workflow, never by the daily refresh; writes research/data/.

Alongside the money it also records how concentrated each basket was, as a
sector Herfindahl index and its reciprocal, the effective number of sectors.
A momentum screen has no diversification constraint, so its top decile can
quietly become a single-sector bet; that is the channel through which one
sector unwinding takes the whole sleeve with it. The same figure for the
whole universe is recorded beside it, so the reader can see how much of the
concentration is the ranking's doing rather than the market's.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import build       # noqa: E402  (shared config, fetching and momentum maths)
import universes   # noqa: E402  (membership reconstruction)

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

REBALANCES = 60           # month ends to run; the 6-year price window sets the real floor
DECILES = 10
MIN_SCORED = 200          # skip a month end whose reconstructed index looks broken
TRADING_DAYS = 252.0

# Whole-universe peer sets only: a "top decile within each sector" portfolio is
# a different strategy, and untested here.
VARIANTS = {"w" + build.ADJUST_KEY[adjust]: adjust for adjust in build.ADJUSTS}


def concentration(basket: set[str], sectors: dict) -> dict:
    """Sector Herfindahl of an equally weighted basket, and what it implies.

    Equal weights make a sector's weight its share of the names, so the index is
    the sum of those squared shares: 1.0 is everything in one sector, and 1/k is
    an even split across k of them. The reciprocal is the number of equally
    sized sectors that would be just as concentrated, which is the form worth
    reading — "4.8 sectors" says more than "0.21".
    """
    counts = defaultdict(int)
    for symbol in basket:
        counts[sectors.get(symbol) or "Unknown"] += 1
    n = sum(counts.values())
    if not n:
        return {}
    weights = sorted(((c / n, name) for name, c in counts.items()), reverse=True)
    hhi = sum(w * w for w, _ in weights)
    return {
        "hhi": hhi,
        "effective": 1 / hhi,
        "count": n,
        "sectors": len(weights),
        "top": weights[0][1],
        "topWeight": weights[0][0],
        "weights": [{"sector": name, "w": w} for w, name in weights],
    }


def max_drawdown(nav: list[float]) -> float:
    """Deepest peak-to-trough fall, as a negative fraction."""
    peak, worst = nav[0], 0.0
    for v in nav:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1.0)
    return worst


def summarise(nav: list[float], dates: list[str]) -> dict:
    """Return, risk and the shape of the ride, from a daily NAV series."""
    rets = [nav[i] / nav[i - 1] - 1.0 for i in range(1, len(nav))]
    mean_d, sd_d = st.mean(rets), st.stdev(rets)
    years = len(rets) / TRADING_DAYS
    cum = nav[-1] / nav[0] - 1.0
    vol = sd_d * TRADING_DAYS ** 0.5
    by_year = defaultdict(list)
    for date, r in zip(dates[1:], rets):
        by_year[date[:4]].append(r)
    return {
        "cagr": (1 + cum) ** (1 / years) - 1 if years > 0 else None,
        "cumulative": cum,
        "vol": vol,
        "dailyMean": mean_d,
        "dailyStdev": sd_d,
        "sharpe": (mean_d * TRADING_DAYS) / vol if vol > 0 else None,   # rf = 0
        "maxDrawdown": max_drawdown(nav),
        "best": max(rets),
        "worst": min(rets),
        "byYear": [
            {
                "year": y,
                # Compounded over the days present, not annualised: a partial
                # first or last year then reads as what it actually was.
                "ret": math.prod(1 + x for x in v) - 1.0,
                "vol": st.stdev(v) * TRADING_DAYS ** 0.5 if len(v) > 1 else None,
                "n": len(v),
            }
            for y, v in sorted(by_year.items())
        ],
    }


def hold(basket: set[str], index_maps: dict, start: str, days: list[str]) -> list[float]:
    """Daily total value of an equal-weighted basket bought at `start`.

    Returns one value per day in `days`, starting from 1.0 at `start`. A name
    with no print on a given day carries its previous value, which covers both
    a stray missing bar and a series that has ended for good.
    """
    held = {}
    # Sorted, so the basket is summed in the same order every run: floating
    # point addition is not associative, and a set's iteration order changes
    # between processes. Without this the weekly job rewrites the file with
    # differences in the sixteenth digit and commits a no-op diff.
    for symbol in sorted(basket):
        dates, closes = index_maps[symbol][0], index_maps[symbol][1]
        pos = bisect_right(dates, start) - 1
        if pos >= 0 and closes[pos] > 0:
            held[symbol] = closes[pos]
    if not held:
        return []
    weight = 1.0 / len(held)
    value = {s: weight for s in held}
    out = []
    for day in days:
        for symbol, last in held.items():
            dates, closes = index_maps[symbol][0], index_maps[symbol][1]
            pos = bisect_right(dates, day) - 1
            if pos >= 0 and dates[pos] == day and closes[pos] > 0:
                value[symbol] *= closes[pos] / last
                held[symbol] = closes[pos]
        out.append(sum(value.values()))
    return out


def main() -> None:
    data = OUT
    data.mkdir(parents=True, exist_ok=True)
    log = build.log

    core_universe, core_changes = universes.load_core()
    sp500_universe, sp500_changes = universes.load_sp500()
    core_now = {c["symbol"] for c in core_universe}
    sp500_now = {c["symbol"] for c in sp500_universe}
    # Sectors are today's, applied to historical baskets: a name's GICS sector
    # almost never changes, and a former member that has left both indices has
    # no sector on file at all, so it lands in "Unknown" rather than distorting
    # a real one.
    sectors = {c["symbol"]: c.get("sector") for c in core_universe}
    for c in sp500_universe:
        sectors.setdefault(c["symbol"], c.get("sector"))
    log(f"universes: {len(core_now)} MidCap 400, {len(sp500_now)} S&P 500")

    window_start = (dt.date.today() - dt.timedelta(days=365 * build.YEARS_OF_PRICES)).isoformat()
    ever = set(core_now) | set(sp500_now)
    for change in core_changes + sp500_changes:
        if change["date"] >= window_start and change["removed"]:
            ever.add(change["removed"])
    log(f"pricing {len(ever)} symbols")

    prices = build.fetch_all_prices(sorted(ever))
    unpriced = sorted(ever - set(prices))
    index_maps = build.make_index_maps(prices)
    calendar = build.trading_days(prices)

    # Rebalance on complete months only, so the final holding period is a full
    # one and the curve never ends mid-month on a partial cross-section.
    rebal_dates = build.month_end_dates(calendar, 120)[-REBALANCES:]
    log(f"{len(rebal_dates)} rebalances, {rebal_dates[0]} → {rebal_dates[-1]}")

    core_at = universes.membership_history(core_now, core_changes, rebal_dates)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, rebal_dates)
    cap_symbols = sorted({s for d in rebal_dates for s in sp500_at[d]} & set(prices))
    caps = universes.fetch_market_caps(cap_symbols)

    members_at = {
        date: (core_at[date] & set(prices))
              | universes.size_tail(sp500_at[date] & set(prices), caps, date)
        for date in rebal_dates
    }
    # Unpriced names that were index members on at least one rebalance date.
    # Only these can change a plotted value; the others left before the window.
    # An S&P 500 name counts only if it would have been small enough for the
    # tail, which cannot be known without its cap, so it is listed as possible.
    unpriced_core = sorted(s for s in unpriced if any(s in core_at[d] for d in rebal_dates))
    unpriced_sp500 = sorted(s for s in unpriced if s not in unpriced_core
                            and any(s in sp500_at[d] for d in rebal_dates))

    # --- baskets: one momentum pass per rebalance, shared by every variant ---
    baskets = {key: {} for key in VARIANTS}     # key -> date -> (top, bottom, all)
    concentrations = {key: [] for key in VARIANTS}   # key -> per-rebalance sector mix
    sizes = {key: [] for key in VARIANTS}            # key -> (ranked, held) per rebalance
    used_dates = []
    for date in rebal_dates:
        legs = build.legs_at(members_at[date], index_maps, date)
        if len(legs) < MIN_SCORED:
            continue
        used_dates.append(date)
        for key, adjust in VARIANTS.items():
            at = build.LEG_VALUE[adjust]
            p12 = build.percentiles({s: v[0][at] for s, v in legs.items()})
            p6 = build.percentiles({s: v[1][at] for s, v in legs.items()})
            blended = {s: build.WEIGHT_LONG * p12[s] + build.WEIGHT_MID * p6[s] for s in legs}
            order = sorted(blended, key=lambda s: (-blended[s], s))   # ties: see rank_block
            size = len(order) // DECILES
            top, whole = set(order[:size]), set(order)
            baskets[key][date] = (top, set(order[-size:]), whole)
            sizes[key].append((len(whole), size))
            concentrations[key].append({
                "date": date,
                "top": concentration(top, sectors),
                "all": concentration(whole, sectors),
            })
    log(f"{len(used_dates)} usable rebalances; "
        f"top decile holds {len(baskets['wr'][used_dates[-1]][0])} names")

    # --- chain the holding periods into one continuous daily series ---
    start = used_dates[0]
    days = [d for d in calendar if d > start]
    report = {
        "from": start,
        "to": days[-1],
        "rebalances": len(used_dates),
        "dates": [start] + days,
        "method": {
            "firstRebalance": used_dates[0],
            "lastRebalance": used_dates[-1],
            "rebalance": "last trading day of each complete month",
            "longDays": build.LONG_DAYS,
            "midDays": build.MID_DAYS,
            "skipDays": build.SKIP_DAYS,
            "minObsLong": build.MIN_OBS_LONG,
            "minObsMid": build.MIN_OBS_MID,
            "weights": [build.WEIGHT_LONG, build.WEIGHT_MID],
            "deciles": DECILES,
            "sizeTail": universes.SIZE_TAIL,
            "minScored": MIN_SCORED,
            "minPriceBars": build.LONG_DAYS + 1,
            "tradingDaysPerYear": TRADING_DAYS,
            "priceSource": "FMP historical-price-eod/dividend-adjusted, adjClose",
            "capSource": "FMP historical-market-capitalization",
            "unpriced": unpriced,
            "unpricedInWindow": unpriced_core,
            "unpricedPossibleTail": unpriced_sp500,
            "ranked": {"min": min(n for n, _ in sizes["wr"]), "max": max(n for n, _ in sizes["wr"])},
            "held": {"min": min(h for _, h in sizes["wr"]), "max": max(h for _, h in sizes["wr"])},
            "skippedMonths": len(rebal_dates) - len(used_dates),
        },
        "variants": {},
    }
    for key, adjust in VARIANTS.items():
        curves = {"top": [1.0], "bottom": [1.0], "all": [1.0]}
        ok = True
        for i, date in enumerate(used_dates):
            if date not in baskets[key]:
                ok = False
                break
            end = used_dates[i + 1] if i + 1 < len(used_dates) else days[-1]
            window = [d for d in calendar if date < d <= end]
            if not window:
                continue
            for slot, basket in zip(("top", "bottom", "all"), baskets[key][date]):
                leg = hold(basket, index_maps, date, window)
                base = curves[slot][-1]
                curves[slot].extend(base * v for v in leg)
        if not ok or len(curves["top"]) < 100:
            log(f"  {key}: not enough coverage, skipped")
            continue
        n = len(curves["top"])
        dates = report["dates"][:n]
        entry = {
            "adjust": adjust,
            "holds": len(baskets[key][used_dates[-1]][0]),
            "members": len(baskets[key][used_dates[-1]][2]),
        }
        for slot, nav in curves.items():
            entry[slot] = [round(100 * v, 2) for v in nav]
            entry[slot + "Stats"] = summarise(nav, dates)
        conc = concentrations[key]
        entry["concentration"] = {
            "series": [{"date": c["date"],
                        "effective": round(c["top"]["effective"], 3),
                        "all": round(c["all"]["effective"], 3),
                        "top": c["top"]["top"],
                        "topWeight": round(c["top"]["topWeight"], 4)}
                       for c in conc],
            "now": conc[-1]["top"],          # full sector breakdown, newest basket only
            "nowAll": conc[-1]["all"],
        }
        report["variants"][key] = entry
        s = entry["topStats"]
        last = conc[-1]
        log(f"  {key}: CAGR {s['cagr']:+.2%}  vol {s['vol']:.1%}  "
            f"maxDD {s['maxDrawdown']:.1%}  vs universe {entry['allStats']['cagr']:+.2%}")
        log(f"       {last['top']['effective']:.1f} effective sectors "
            f"(universe {last['all']['effective']:.1f}); biggest "
            f"{last['top']['topWeight']:.0%} {last['top']['top']}")

    if len(report["dates"]) > len(next(iter(report["variants"].values()))["top"]):
        report["dates"] = report["dates"][:len(next(iter(report["variants"].values()))["top"])]

    (data / "portfolio.json").write_text(json.dumps(report, separators=(",", ":")) + "\n")
    log(f"wrote portfolio.json  {(data / 'portfolio.json').stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
