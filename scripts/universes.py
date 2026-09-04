#!/usr/bin/env python3
"""Universe definition and point-in-time membership reconstruction.

One universe, assembled from two sources:

* the **S&P MidCap 400**. Current members come from Wikipedia (no FMP plan tier
  exposes a MidCap 400 constituent endpoint); history comes from Wikipedia's
  "Selected changes" table, walked backwards from today.
* plus the smallest `SIZE_TAIL` members of the **S&P 500** by market
  capitalisation, giving a ~650-name mid-cap-and-down universe. Both the S&P 500
  membership and the market caps used to pick that tail are themselves
  point-in-time, so the cut is made with the caps that were true on the day.

The boundary between the two is an index committee's, not a size boundary, so
crossing it is what the tail is for: a name is measured against everything of
roughly its size rather than against which index happens to hold it.

Shared by build.py (the live ranking), backtest.py and portfolio.py.
"""

from __future__ import annotations

import datetime as dt
import html
import re
from bisect import bisect_right

import build

SIZE_TAIL = 250          # S&P 500 names, smallest by market cap, added to core
CAP_YEARS = 4            # depth of market-cap history to request


def strip_tags(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).replace("\xa0", " ").strip()


VALID = re.compile(r"[A-Z][A-Z0-9-]{0,6}")

# FMP's S&P 500 endpoint labels sectors with the Yahoo/Morningstar taxonomy while
# Wikipedia's MidCap 400 table uses GICS names. Left unmapped, the extended
# universe would rank a name against others from its own *source* rather than
# its own sector. GICS is the target because it is what the index itself uses.
# The mapping is exact for the eleven sector names; at the company level the two
# taxonomies disagree on a handful of edge cases (payment processors, for one),
# which no name-level mapping can fix.
GICS = {
    "Technology": "Information Technology",
    "Healthcare": "Health Care",
    "Financial Services": "Financials",
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Basic Materials": "Materials",
}


def gics(sector: str) -> str:
    return GICS.get(sector, sector)


def valid(symbol: str) -> bool:
    return bool(VALID.fullmatch(symbol))


# --- Loaders: fresh if possible, committed snapshot if not --------------------

def load_core() -> tuple[list[dict], list[dict]]:
    """MidCap 400 constituents and change log, from Wikipedia or data/universe.json."""
    payload = build.snapshot(
        "universe",
        lambda: {"constituents": build.scrape_universe(), "changes": core_changes()},
        "MidCap 400 universe",
    )
    return payload["constituents"], payload.get("changes", [])


def load_sp500() -> tuple[list[dict], list[dict]]:
    """S&P 500 constituents and change log, from FMP or data/sp500.json."""
    payload = build.snapshot(
        "sp500",
        lambda: {"constituents": sp500_constituents(), "changes": sp500_changes()},
        "S&P 500 universe",
    )
    return payload["constituents"], payload.get("changes", [])


# --- Current membership -------------------------------------------------------

def sp500_constituents() -> list[dict]:
    rows = build.fmp("sp500-constituent")
    out = []
    for r in rows:
        symbol = build.normalise(r.get("symbol", ""))
        if valid(symbol):
            out.append(
                {
                    "symbol": symbol,
                    "name": r.get("name", symbol),
                    "sector": gics(r.get("sector", "")),
                    "industry": r.get("subSector", ""),
                }
            )
    return out


# --- Change logs --------------------------------------------------------------

def core_changes() -> list[dict]:
    """S&P 400 additions/removals from Wikipedia, newest first."""
    page = build.http_get(build.WIKI).decode("utf-8", "replace")
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
                when = dt.datetime.strptime(cells[0], "%B %d, %Y").date().isoformat()
            except ValueError:
                continue
            added, removed = build.normalise(cells[1]), build.normalise(cells[3])
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


def sp500_changes() -> list[dict]:
    """S&P 500 additions/removals from FMP, newest first."""
    changes = []
    for r in build.fmp("historical-sp500-constituent"):
        raw = r.get("date")
        if not raw:
            continue
        try:
            when = dt.date.fromisoformat(raw[:10]).isoformat()
        except ValueError:
            continue
        added = build.normalise(r.get("symbol") or "")
        removed = build.normalise(r.get("removedTicker") or "")
        changes.append(
            {
                "date": when,
                "added": added if valid(added) else None,
                "removed": removed if valid(removed) else None,
            }
        )
    changes.sort(key=lambda c: c["date"], reverse=True)
    return changes


def membership_history(current: set[str], changes: list[dict], dates: list[str]) -> dict[str, set[str]]:
    """Membership at each date in `dates`, by undoing changes newer than it.
    Dates are ISO strings throughout, which compare correctly as text."""
    out: dict[str, set[str]] = {}
    members = set(current)
    cursor = 0
    for date in sorted(dates, reverse=True):
        while cursor < len(changes) and changes[cursor]["date"] > date:
            change = changes[cursor]
            if change["added"]:
                members.discard(change["added"])
            if change["removed"]:
                members.add(change["removed"])
            cursor += 1
        out[date] = set(members)
    return out


# --- Market caps --------------------------------------------------------------

def fetch_market_caps(symbols: list[str]) -> dict[str, tuple[list[str], list[float]]]:
    """Daily market cap per symbol, as (dates, caps) for bisect lookup."""
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * CAP_YEARS))).isoformat()

    def one(symbol: str):
        rows = build.cached_fmp(
            f"cap-{symbol}",
            "historical-market-capitalization",
            symbol=symbol, limit=5000, **{"from": start},
        )
        series = sorted(
            (r["date"], float(r["marketCap"]))
            for r in rows
            if isinstance(r, dict) and r.get("marketCap")
        )
        return [d for d, _ in series], [c for _, c in series]

    return build.gather(symbols, one, "market caps")


def cap_at(caps: dict, symbol: str, date: str):
    entry = caps.get(symbol)
    if not entry:
        return None
    dates, values = entry
    i = bisect_right(dates, date) - 1
    return values[i] if i >= 0 else None


def size_tail(members: set[str], caps: dict, date: str, n: int = SIZE_TAIL) -> set[str]:
    """The `n` smallest members by market cap on `date`."""
    sized = [(cap_at(caps, s, date), s) for s in members]
    sized = [(c, s) for c, s in sized if c]
    sized.sort()
    return {s for _, s in sized[:n]}
