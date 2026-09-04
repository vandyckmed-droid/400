#!/usr/bin/env python3
"""Point-in-time backtest of the blended momentum score.

Reconstructs S&P MidCap 400 membership month by month by walking Wikipedia's
"Selected changes" table backwards from today's constituent list, re-ranks the
members alive at each month end, and measures what the ranking was worth: 1/3/6
month forward returns by decile, the top-minus-bottom spread, and how often the
top decile actually beat the bottom one.

Reuses build.py for price fetching and the momentum maths, so the backtest and
the live site cannot silently diverge.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402  (shared config, fetching and momentum maths)

WIKI = build.WIKI
HORIZONS = (1, 3, 6)      # forward-return horizons, in months
DECILES = 10
MIN_MEMBERS = 200         # skip a month end whose reconstructed index looks broken


def strip_tags(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).replace("\xa0", " ").strip()


# --- Membership reconstruction ------------------------------------------------

def parse_changes() -> list[dict]:
    """Index additions and removals, newest first."""
    page = build.http_get(WIKI).decode("utf-8", "replace")
    tables = re.findall(r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>.*?</table>', page, re.S)
    changes = []
    for table in tables:
        headers = [strip_tags(h) for h in re.findall(r"<th[^>]*>(.*?)</th>", table, re.S)]
        if "Added" not in headers or "Removed" not in headers:
            continue
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
            cells = [strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
            if len(cells) < 5:
                continue
            try:
                when = dt.datetime.strptime(cells[0], "%B %d, %Y").date()
            except ValueError:
                continue
            added, removed = build.normalise(cells[1]), build.normalise(cells[3])
            valid = lambda s: bool(re.fullmatch(r"[A-Z][A-Z0-9-]{0,6}", s))  # noqa: E731
            changes.append(
                {
                    "date": when,
                    "added": added if valid(added) else None,
                    "removed": removed if valid(removed) else None,
                }
            )
        break
    changes.sort(key=lambda c: c["date"], reverse=True)
    return changes


def membership_history(current: set[str], changes: list[dict], dates: list[str]):
    """Membership at each date in `dates` (ascending), walking changes backwards."""
    out: dict[str, set[str]] = {}
    members = set(current)
    cursor = 0
    for date in sorted(dates, reverse=True):
        target = dt.date.fromisoformat(date)
        # Undo every change that happened after `target`.
        while cursor < len(changes) and changes[cursor]["date"] > target:
            change = changes[cursor]
            if change["added"]:
                members.discard(change["added"])
            if change["removed"]:
                members.add(change["removed"])
            cursor += 1
        out[date] = set(members)
    return out


# --- Returns ------------------------------------------------------------------

def forward_return(series, index_map, start: str, months: int):
    """Total return from `start` to `start + months`, on adjusted closes.

    A series that ends early (acquisition, delisting) is held to its last print
    and then treated as cash — the standard conservative treatment.
    """
    dates, closes = index_map
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
    universe = build.load_universe()
    current = {c["symbol"] for c in universe}
    changes = parse_changes()
    log = build.log
    log(f"changes table: {len(changes)} add/remove events, newest {changes[0]['date']}")

    # Every symbol that was a member at any point in the window we care about.
    horizon_start = dt.date.today() - dt.timedelta(days=365 * 4)
    ever = set(current)
    for change in changes:
        if change["date"] >= horizon_start and change["removed"]:
            ever.add(change["removed"])
    log(f"symbols to price: {len(ever)} ({len(ever) - len(current)} former members)")

    prices = build.fetch_all_prices(sorted(ever))
    index_maps = {s: ([d for d, _ in v], [c for _, c in v]) for s, v in prices.items()}
    calendar = sorted({d for series in prices.values() for d, _ in series})

    # Month ends we can both rank at and measure a 6-month forward return from.
    all_month_ends = build.month_end_dates(calendar, 96)
    last_usable = add_months(calendar[-1], -max(HORIZONS))
    ranking_dates = [d for d in all_month_ends if d <= last_usable][-build.HISTORY_MONTHS:]
    log(f"{len(ranking_dates)} ranking dates, {ranking_dates[0]} → {ranking_dates[-1]}")

    members_at = membership_history(current, changes, ranking_dates)

    rows_by_h = {h: defaultdict(list) for h in HORIZONS}   # horizon -> decile -> returns
    spreads = {h: [] for h in HORIZONS}
    coverage, skipped = [], 0

    for date in ranking_dates:
        members = members_at[date]
        scored = {}
        for symbol in members:
            if symbol not in index_maps:
                continue
            dates, closes = index_maps[symbol]
            pos = bisect_right(dates, date) - 1
            if pos < 0:
                continue
            long_leg = build.vol_adjusted_momentum(closes, pos, build.LONG_DAYS, build.MIN_OBS_LONG)
            mid_leg = build.vol_adjusted_momentum(closes, pos, build.MID_DAYS, build.MIN_OBS_MID)
            if long_leg and mid_leg:
                scored[symbol] = (long_leg[2], mid_leg[2])

        if len(scored) < MIN_MEMBERS:
            skipped += 1
            continue
        coverage.append((len(members), len(scored)))

        p12 = build.percentiles({s: v[0] for s, v in scored.items()})
        p6 = build.percentiles({s: v[1] for s, v in scored.items()})
        blended = {s: 0.5 * p12[s] + 0.5 * p6[s] for s in scored}
        order = sorted(blended, key=lambda s: -blended[s])
        size = len(order) // DECILES

        for h in HORIZONS:
            means = []
            for d in range(DECILES):
                bucket = order[d * size : (d + 1) * size] if d < DECILES - 1 else order[d * size :]
                rets = [r for r in (forward_return(prices[s], index_maps[s], date, h) for s in bucket)
                        if r is not None]
                if not rets:
                    means.append(None)
                    continue
                mean = st.mean(rets)
                rows_by_h[h][d].append(mean)
                means.append(mean)
            if means[0] is not None and means[-1] is not None:
                spreads[h].append((date, means[0] - means[-1]))

    log(f"used {len(coverage)} month ends (skipped {skipped}); "
        f"median members {st.median(m for m, _ in coverage):.0f}, "
        f"median scored {st.median(s for _, s in coverage):.0f}")

    report = {"rankingDates": len(coverage), "horizons": {}}
    print()
    for h in HORIZONS:
        print(f"=== {h}-MONTH FORWARD RETURNS, equal-weighted, {len(spreads[h])} month ends ===")
        print("  decile   mean     median     win rate   n")
        decile_stats = []
        for d in range(DECILES):
            v = rows_by_h[h][d]
            row = {
                "decile": d + 1,
                "mean": st.mean(v),
                "median": st.median(v),
                "winRate": sum(1 for x in v if x > 0) / len(v),
                "n": len(v),
            }
            decile_stats.append(row)
            label = "D1 (top)" if d == 0 else "D10 (bot)" if d == 9 else f"D{d + 1}"
            print(f"  {label:>9} {row['mean']:+7.2%}  {row['median']:+7.2%}   "
                  f"{row['winRate']:6.0%}   {row['n']}")
        sp = [s for _, s in spreads[h]]
        hit = sum(1 for s in sp if s > 0) / len(sp)
        tstat = st.mean(sp) / (st.stdev(sp) / len(sp) ** 0.5) if len(sp) > 1 else float("nan")
        print(f"  TOP-MINUS-BOTTOM  mean {st.mean(sp):+.2%}  median {st.median(sp):+.2%}  "
              f"hit rate {hit:.0%}  t={tstat:.2f}")
        print(f"  best {max(sp):+.1%}  worst {min(sp):+.1%}\n")
        report["horizons"][h] = {
            "deciles": decile_stats,
            "spread": {
                "mean": st.mean(sp), "median": st.median(sp), "hitRate": hit,
                "t": tstat, "best": max(sp), "worst": min(sp),
                "series": [{"date": d, "spread": s} for d, s in spreads[h]],
            },
        }

    out = Path(__file__).resolve().parent.parent / "data" / "backtest.json"
    out.write_text(json.dumps(report, separators=(",", ":")) + "\n")
    build.log(f"wrote {out.name}")


if __name__ == "__main__":
    main()
