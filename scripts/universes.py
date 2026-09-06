#!/usr/bin/env python3
"""Universe definition and point-in-time membership reconstruction.

One universe, assembled from two sources:

* the **S&P MidCap 400**. Current members come from Wikipedia (no FMP plan tier
  exposes a MidCap 400 constituent endpoint); history comes from Wikipedia's
  historical-components page, walked backwards from today.
* the **S&P 500**, members and change log from FMP.

Together they are the S&P 900: roughly 900 names, each ranked against all the
others whichever index happens to hold it.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import re
from bisect import bisect_right

import build


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
    """MidCap 400 constituents and change log, from Wikipedia or data/universe.json.

    An empty change log is treated as the source being down: without it every
    historical cross-section would silently use today's membership. The log is
    also used to correct the constituents table when an edit has rolled it back
    past a change it records (as happened in September 2026)."""
    def fetch():
        changes = core_changes()
        if not changes:
            raise RuntimeError("no change log found on either Wikipedia page")
        return {"constituents": reconcile(build.scrape_universe(), changes), "changes": changes}
    payload = build.snapshot("universe", fetch, "MidCap 400 universe")
    return payload["constituents"], payload.get("changes", [])


def reconcile(constituents: list[dict], changes: list[dict]) -> list[dict]:
    """Apply any logged change up to today that the constituents table has not
    caught up with: the removed name still listed and the added one missing.
    The added name's details come from the committed snapshot, if it has them;
    otherwise the table is left alone and the mismatch logged."""
    today = dt.date.today().isoformat()
    listed = {c["symbol"]: c for c in constituents}
    known = {}
    path = build.DATA / "universe.json"
    if path.exists():
        known = {c["symbol"]: c for c in json.loads(path.read_text()).get("constituents", [])}
    # Only a name's latest logged move counts: one removed years ago and since
    # re-added is rightly in the table, whatever the older entry says.
    latest = {}
    for change in sorted((c for c in changes if c["date"] <= today), key=lambda c: c["date"], reverse=True):
        for symbol, move in ((change.get("added"), "in"), (change.get("removed"), "out")):
            if symbol and symbol not in latest:
                latest[symbol] = (change["date"], move)
    for change in changes:
        added, removed = change.get("added"), change.get("removed")
        if change["date"] > today or not added or not removed:
            continue
        if added in listed or removed not in listed:
            continue
        if latest.get(added) != (change["date"], "in") or latest.get(removed) != (change["date"], "out"):
            continue
        if added not in known:
            build.log(f"universe: table still lists {removed} after {added} replaced it on "
                      f"{change['date']}; no details for {added}, leaving it")
            continue
        build.log(f"universe: table still lists {removed}; applying {added} for {removed} "
                  f"({change['date']}) from the change log")
        del listed[removed]
        listed[added] = known[added]
    return sorted(listed.values(), key=lambda c: c["symbol"])


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
    """S&P 400 additions/removals from Wikipedia, newest first: the historical
    components page, or the list page itself if the table is (back) there."""
    for url in (build.WIKI_CHANGES, build.WIKI):
        try:
            changes = changes_on(build.http_get(url).decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001 - try the other page
            build.log(f"change log: {url.rsplit('/', 1)[-1]} failed ({exc})")
            continue
        if changes:
            return changes
    return []


def changes_on(page: str) -> list[dict]:
    """The first wikitable on `page` with Added and Removed columns, as changes."""
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
