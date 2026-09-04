#!/usr/bin/env python3
"""Build the momentum ranking data files.

Pipeline
--------
1. Resolve the universe with point-in-time membership (universes.py): the
   MidCap 400 plus the 250 smallest S&P 500 names by market cap, ~650 in all.
   Each source falls back to a committed snapshot if it is down.
2. Pull ~6 years of dividend/split-adjusted daily closes per ticker from FMP.
3. At each month end and week end, compute the 12-1 and 6-1 legs once per name,
   then rank them four ways: on the return or on the return over its own
   volatility, each against the whole universe or against the name's sector.
4. Refuse to publish if the result looks degraded (guard()), else emit
   data/latest.json and data/history/{wr,wv,sr,sv}[w].json.

Only the standard library is used, so the refresh job needs no dependencies.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import gzip
import html
import json
import math
import os
import random
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from bisect import bisect_left, bisect_right
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / ".cache" / "prices"

FMP = "https://financialmodelingprep.com/stable"
WIKI = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"

# --- Ranking parameters -------------------------------------------------------
# Trading-day windows. 21d ~ 1 month, 252d ~ 12 months.
SKIP_DAYS = 21          # the "-1" in 12-1 / 6-1: skip the most recent month
LONG_DAYS = 252         # 12-month formation window
MID_DAYS = 126          # 6-month formation window
MIN_OBS_LONG = 180      # min daily returns required in the 12-1 window
MIN_OBS_MID = 90        # min daily returns required in the 6-1 window
HISTORY_MONTHS = 36     # month-end snapshots to publish
SPARK_MONTHS = 12       # months of score strip drawn inline in each list row
HISTORY_WEEKS = 78      # week-end snapshots (18 months) for the finer-grained view
YEARS_OF_PRICES = 6     # history depth to request from FMP
MIN_NAMES_PER_SNAPSHOT = 50   # skip cross-sections thinner than this
WEIGHT_LONG = 0.5       # 12-1 weight in the blend
WEIGHT_MID = 0.5        # 6-1 weight in the blend
MIN_SECTOR = 5          # smallest sector that gets a within-sector percentile

# The four peer sets a name can be ranked against, keyed by two letters:
# whether the cross-section is the whole universe or just the name's own sector
# (w|s), and what gets ranked (r = the return itself, v = the return divided by
# its own volatility). The universe is not an axis: there is one, defined below.
PEER_SETS = {
    basis[0] + adjust[0]: (basis, adjust)
    for basis in ("whole", "sector")
    for adjust in ("raw", "vol")
}
# vol_adjusted_momentum returns (raw return, annualised vol, raw / vol); this
# picks which of those three the cross-sectional percentile is taken over.
LEG_VALUE = {"raw": 0, "vol": 2}

WORKERS = 5            # the vendor throttles above this on large payloads
RETRIES = 6
UA = "sp400-momentum-ranker/1.0 (+https://github.com/vandyckmed-droid/400)"

API_KEY = os.environ.get("FMP_API_KEY") or os.environ.get("API_KEY") or ""
if not API_KEY:
    sys.exit("FMP_API_KEY (or API_KEY) must be set in the environment")

_SSL = ssl.create_default_context()


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def http_get(url: str, timeout: int = 45) -> bytes:
    """GET with retries and gzip support. Raises on persistent failure."""
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"}
            )
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except Exception as exc:  # noqa: BLE001 - retry everything transport-level
            last = exc
            # Jittered backoff: throttling hits whole batches at once, so
            # retrying in lockstep just reproduces the collision.
            time.sleep(min(30, 2 ** attempt) * (0.6 + random.random() * 0.8))
    raise RuntimeError(f"GET failed after {RETRIES} tries: {url.split('apikey=')[0]}") from last


def fmp(path: str, **params) -> object:
    params["apikey"] = API_KEY
    url = f"{FMP}/{path}?{urllib.parse.urlencode(params)}"
    body = http_get(url).decode("utf-8", "replace")
    data = json.loads(body)
    if isinstance(data, dict) and ("Error Message" in data or "error" in data):
        raise RuntimeError(f"FMP error on {path}: {data}")
    return data


# --- 1. Universe --------------------------------------------------------------

def normalise(symbol: str) -> str:
    """Wikipedia writes share classes as BRK.B; FMP uses BRK-B."""
    return symbol.strip().upper().replace(".", "-")


def scrape_universe() -> list[dict]:
    page = http_get(WIKI).decode("utf-8", "replace")
    tables = re.findall(r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>.*?</table>', page, re.S)
    for table in tables:
        headers = [strip_tags(h) for h in re.findall(r"<th[^>]*>(.*?)</th>", table, re.S)]
        if not headers or "Symbol" not in headers[0]:
            continue
        out = []
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
            if len(cells) < 4:
                continue
            symbol = normalise(strip_tags(cells[0]))
            if not re.fullmatch(r"[A-Z][A-Z0-9-]{0,6}", symbol):
                continue
            out.append(
                {
                    "symbol": symbol,
                    "name": strip_tags(cells[1]),
                    "sector": strip_tags(cells[2]),
                    "industry": strip_tags(cells[3]),
                }
            )
        if len(out) > 300:
            return out
    raise RuntimeError("could not locate the S&P 400 constituents table")


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(text).replace(" ", " ").strip()


def snapshot(name: str, fetch, describe: str) -> dict:
    """Fetch fresh and persist to data/<name>.json, or fall back to the committed
    copy if the source is down. A vendor or Wikipedia outage then degrades the
    weekly refresh to last week's membership instead of failing it outright."""
    path = DATA / f"{name}.json"
    try:
        payload = fetch()
        path.write_text(json.dumps({"asOf": dt.date.today().isoformat(), **payload}, indent=1) + "\n")
        return payload
    except Exception as exc:  # noqa: BLE001 - degrade to the committed snapshot
        if not path.exists():
            raise
        log(f"{describe}: fetch failed ({exc}); using committed snapshot")
        return json.loads(path.read_text())


def load_universe() -> list[dict]:
    """Current MidCap 400 constituents. Kept for backtest.py's import."""
    import universes
    return universes.load_core()[0]


def guard(condition: bool, message: str) -> None:
    """Refuse to publish a degraded ranking. A partial vendor outage that drops
    a chunk of names would otherwise commit a quietly wrong cross-section."""
    if not condition:
        sys.exit(f"refusing to publish: {message}")


# --- 2. Prices ----------------------------------------------------------------

def cached_fmp(key: str, path: str, **params):
    """An FMP call memoised on disk for 12 hours, so re-runs while iterating
    cost nothing and a failed run doesn't re-pay for what already succeeded."""
    cache_file = CACHE / f"{key}.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 12 * 3600:
        return json.loads(cache_file.read_text())
    rows = fmp(path, **params)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(rows))
    return rows


def gather(items: list[str], fn, label: str) -> dict:
    """Run `fn` over `items` concurrently, tolerating individual failures."""
    out, failures = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fn, item): item for item in items}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            item = futures[future]
            try:
                result = future.result()
                if result:
                    out[item] = result
                else:
                    failures.append(item)
            except Exception as exc:  # noqa: BLE001
                failures.append(item)
                if len(failures) < 6:
                    log(f"  {label} failed for {item}: {exc}")
            if done % 200 == 0:
                log(f"  {label} {done}/{len(items)}")
    if failures:
        log(f"{label}: {len(failures)} without data ({', '.join(sorted(failures)[:10])})")
    return out


def fetch_prices(symbol: str, start: str) -> list[tuple[str, float]]:
    """Adjusted daily closes, oldest first."""
    rows = cached_fmp(
        f"px-{symbol}", "historical-price-eod/dividend-adjusted",
        symbol=symbol, **{"from": start},
    )
    series = sorted(
        (r["date"], float(r["adjClose"]))
        for r in rows
        if isinstance(r, dict) and r.get("adjClose") not in (None, 0)
    )
    return series if len(series) > LONG_DAYS else []


def fetch_all_prices(symbols: list[str]) -> dict[str, list[tuple[str, float]]]:
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * YEARS_OF_PRICES))).isoformat()
    return gather(symbols, lambda s: fetch_prices(s, start), "prices")


def fetch_quotes(symbols: list[str]) -> dict[str, dict]:
    """Market cap / 52w range / last change, batched."""
    quotes: dict[str, dict] = {}
    for i in range(0, len(symbols), 50):
        chunk = symbols[i : i + 50]
        try:
            for row in fmp("batch-quote", symbols=",".join(chunk)):
                if isinstance(row, dict) and row.get("symbol"):
                    quotes[row["symbol"]] = row
        except Exception as exc:  # noqa: BLE001 - quotes are cosmetic, keep going
            log(f"  quotes failed for chunk {i // 50}: {exc}")
    log(f"quotes: {len(quotes)}/{len(symbols)}")
    return quotes


# --- 3. Momentum --------------------------------------------------------------

def vol_adjusted_momentum(closes: list[float], end: int, lookback: int, min_obs: int):
    """Return (raw return, annualised vol, vol-adjusted momentum) or None.

    `end` indexes the most recent bar at or before the snapshot date. The
    formation window runs from `end - lookback` to `end - SKIP_DAYS`, so the
    most recent month is excluded (the "-1" in 12-1 / 6-1).
    """
    stop = end - SKIP_DAYS
    start = end - lookback
    if start < 0 or stop - start < min_obs:
        return None
    p0, p1 = closes[start], closes[stop]
    if p0 <= 0 or p1 <= 0:
        return None
    raw = p1 / p0 - 1.0

    rets = []
    for i in range(start + 1, stop + 1):
        prev, cur = closes[i - 1], closes[i]
        if prev > 0 and cur > 0:
            rets.append(math.log(cur / prev))
    if len(rets) < min_obs:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    vol = math.sqrt(var) * math.sqrt(252.0)
    if vol <= 1e-6:
        return None
    return raw, vol, raw / vol


def percentiles(values: dict[str, float]) -> dict[str, float]:
    """Cross-sectional 0-100 percentile using average ranks (ties share a rank)."""
    n = len(values)
    if n < 2:
        return {k: 50.0 for k in values}
    ordered = sorted(values.items(), key=lambda kv: kv[1])
    out: dict[str, float] = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and ordered[j + 1][1] == ordered[i][1]:
            j += 1
        avg_rank = (i + j) / 2.0            # 0-based average rank across the tie group
        pct = 100.0 * avg_rank / (n - 1)
        for k in range(i, j + 1):
            out[ordered[k][0]] = pct
        i = j + 1
    return out


def week_end_dates(calendar: list[str], count: int) -> list[str]:
    """The last trading day of each of the most recent `count` ISO weeks.

    Unlike the monthly axis this keeps the in-progress week: a bar is a
    cross-section taken on a date, not a return over a period, so a partial
    week is still a valid reading and it keeps the last bar close to today.
    """
    by_week: dict[tuple[int, int], str] = {}
    for date in calendar:
        year, week, _ = dt.date.fromisoformat(date).isocalendar()
        by_week[(year, week)] = date
    return [by_week[w] for w in sorted(by_week)[-count:]]


def month_end_dates(calendar: list[str], count: int) -> list[str]:
    """The last trading day of each of the most recent `count` complete months."""
    by_month: dict[str, str] = {}
    for date in calendar:
        by_month[date[:7]] = date          # calendar is sorted, so this keeps the last
    months = sorted(by_month)
    if months and months[-1][:7] == dt.date.today().strftime("%Y-%m"):
        months.pop()                        # drop the in-progress month
    return [by_month[m] for m in months[-count:]]


def rank_block(legs: dict, meta: dict, basis: str, adjust: str,
               outsiders: dict | None = None) -> dict:
    """Turn momentum legs into percentiles, a blended score and a rank.

    `basis` picks the cross-section each name is measured against: "whole" ranks
    it against every member of the universe, "sector" only against its own GICS
    sector. Sectors thinner than MIN_SECTOR are left unscored — a percentile
    across four names says nothing.

    `adjust` picks what is ranked: "raw" ranks the return itself, "vol" ranks
    the return divided by the volatility of the same window, so a steady climb
    outranks an equally large but erratic one. Both are published; the app
    chooses between them.

    `outsiders` are names that were not members on this date but are published
    today. They are scored against the member distribution as if inserted into
    it — where they *would* have ranked — without disturbing the members' own
    percentiles. That gives a recent joiner a full history chart while keeping
    every historical cross-section point-in-time.
    """
    at = LEG_VALUE[adjust]
    long_of = lambda s: legs[s][0][at]      # noqa: E731 - terse by design, used four times
    mid_of = lambda s: legs[s][1][at]       # noqa: E731

    if basis == "whole":
        groups = {"*": set(legs)}
    else:
        groups = {}
        for symbol in legs:
            groups.setdefault(meta.get(symbol, {}).get("sector", ""), set()).add(symbol)

    out = {}
    for sector, members in groups.items():
        if basis == "sector" and (not sector or len(members) < MIN_SECTOR):
            continue
        p_long = percentiles({s: long_of(s) for s in members})
        p_mid = percentiles({s: mid_of(s) for s in members})
        blended = {s: WEIGHT_LONG * p_long[s] + WEIGHT_MID * p_mid[s] for s in members}
        # Ties are common — two names sharing both leg ranks blend to the same
        # score — and `members` is a set, whose iteration order changes between
        # processes. Without the symbol as a second key the rank a tied name
        # gets, and which side of a decile boundary it lands on, would differ
        # from run to run on identical inputs.
        for rank, symbol in enumerate(sorted(members, key=lambda s: (-blended[s], s)), 1):
            out[symbol] = {
                "s": round(blended[symbol], 2),
                "k": rank,
                "n": len(members),
                "p12": round(p_long[symbol], 2),
                "p6": round(p_mid[symbol], 2),
            }
        if outsiders:
            n = len(members)
            long_sorted = sorted(long_of(s) for s in members)
            mid_sorted = sorted(mid_of(s) for s in members)
            for symbol, leg in outsiders.items():
                if basis == "sector" and meta.get(symbol, {}).get("sector", "") != sector:
                    continue
                p_l = 100.0 * bisect_left(long_sorted, leg[0][at]) / n
                p_m = 100.0 * bisect_left(mid_sorted, leg[1][at]) / n
                out[symbol] = {
                    "s": round(WEIGHT_LONG * p_l + WEIGHT_MID * p_m, 2),
                    "k": None, "n": n, "p12": round(p_l, 2), "p6": round(p_m, 2),
                    "outside": True,
                }
    return out


def legs_at(members, index_maps, date: str) -> dict:
    """The 12-1 and 6-1 legs for every member with enough history at `date`.

    Each leg is (raw return, annualised vol, raw / vol), so a caller can rank on
    the return or on the volatility-adjusted return without recomputing.
    """
    out = {}
    # Sorted, so this dict — and everything downstream that inherits its
    # insertion order, including the key order of the history files — is the
    # same on every run. `members` is a set, and a set of strings iterates in a
    # different order in every process.
    for symbol in sorted(members):
        entry = index_maps.get(symbol)
        if not entry:
            continue
        dates, closes = entry
        pos = bisect_right(dates, date) - 1
        if pos < 0:
            continue
        long_leg = vol_adjusted_momentum(closes, pos, LONG_DAYS, MIN_OBS_LONG)
        mid_leg = vol_adjusted_momentum(closes, pos, MID_DAYS, MIN_OBS_MID)
        if long_leg and mid_leg:
            out[symbol] = (long_leg, mid_leg)
    return out


# --- Assemble -----------------------------------------------------------------

def main() -> None:
    import universes

    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "history").mkdir(exist_ok=True)

    core_universe, core_changes = universes.load_core()
    sp500_universe, sp500_changes = universes.load_sp500()
    log(f"universes: {len(core_universe)} MidCap 400, {len(sp500_universe)} S&P 500; "
        f"change logs {len(core_changes)} / {len(sp500_changes)}")

    meta = {c["symbol"]: c for c in core_universe}
    for c in sp500_universe:
        meta.setdefault(c["symbol"], c)
    core_now = {c["symbol"] for c in core_universe}
    sp500_now = {c["symbol"] for c in sp500_universe}

    window_start = (dt.date.today() - dt.timedelta(days=365 * 4)).isoformat()
    ever = set(core_now) | set(sp500_now)
    for change in core_changes + sp500_changes:
        if change["date"] >= window_start and change["removed"]:
            ever.add(change["removed"])
    log(f"pricing {len(ever)} symbols (current members plus former ones still in window)")

    prices = fetch_all_prices(sorted(ever))
    index_maps = {s: ([d for d, _ in v], [c for _, c in v]) for s, v in prices.items()}
    calendar = sorted({d for series in prices.values() for d, _ in series})
    as_of = calendar[-1]
    snapshot_dates = month_end_dates(calendar, HISTORY_MONTHS)
    weekly_dates = week_end_dates(calendar, HISTORY_WEEKS)
    all_dates = sorted(set(snapshot_dates) | set(weekly_dates) | {as_of})
    log(f"as of {as_of}; {len(snapshot_dates)} monthly snapshots from {snapshot_dates[0]}")

    core_at = universes.membership_history(core_now, core_changes, all_dates)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, all_dates)

    # Market caps are only needed to pick the small tail of the S&P 500.
    cap_symbols = sorted({s for d in all_dates for s in sp500_at[d]} & set(prices))
    log(f"market caps for {len(cap_symbols)} S&P 500 names (to size the tail)")
    caps = universes.fetch_market_caps(cap_symbols)

    # The universe: the MidCap 400 as it stood that day, plus the smallest tail
    # of the S&P 500 by the market caps that were true that day.
    members_at = {}
    for date in all_dates:
        tail = universes.size_tail(sp500_at[date] & set(prices), caps, date)
        members_at[date] = (core_at[date] & set(prices)) | tail
    log(f"universe today: {len(members_at[as_of])} names "
        f"({len(core_at[as_of] & set(prices))} from the MidCap 400 + "
        f"{len(members_at[as_of]) - len(core_at[as_of] & set(prices))} S&P 500 tail)")

    # --- today's cross-sections ---
    legs_now = legs_at(members_at[as_of], index_maps, as_of)
    live = set(legs_now)                          # every name the site will publish

    # --- history: one momentum pass per date, reused by all four peer sets ---
    def build_history(dates):
        history = {key: {} for key in PEER_SETS}
        outside = {key: {} for key in PEER_SETS}
        kept = []
        for date in dates:
            legs = legs_at(members_at[date] | live, index_maps, date)
            if sum(1 for s in legs if s in members_at[date]) < MIN_NAMES_PER_SNAPSHOT:
                continue
            kept.append(date)
            members = {s: v for s, v in legs.items() if s in members_at[date]}
            # Published names that were not members on this date are scored
            # against that day's distribution as outsiders, so a recent joiner
            # still gets a full chart without disturbing the cross-section.
            joiners = {s: v for s, v in legs.items() if s not in members_at[date]}
            for key, (basis, adjust) in PEER_SETS.items():
                for symbol, block in rank_block(members, meta, basis, adjust, joiners).items():
                    history[key].setdefault(symbol, {})[date] = round(block["s"], 1)
                    if block.get("outside"):
                        outside[key].setdefault(symbol, set()).add(date)
        return history, outside, kept

    history, history_outside, kept_dates = build_history(snapshot_dates)
    weekly, weekly_outside, kept_weeks = build_history(weekly_dates)
    log(f"history: {len(kept_dates)} monthly, {len(kept_weeks)} weekly cross-sections; "
        f"{sum(len(v) for v in history_outside.values())} name/peer-set pairs carry pre-membership bars")
    blocks = {
        key: rank_block(legs_now, meta, basis, adjust)
        for key, (basis, adjust) in PEER_SETS.items()
    }

    ranked = sorted(legs_now)
    quotes = fetch_quotes(ranked)
    rows = []
    for symbol in ranked:
        long_leg, mid_leg = legs_now[symbol]
        info = meta.get(symbol, {})
        q = quotes.get(symbol, {})
        placement = {k: blocks[k][symbol] for k in PEER_SETS if symbol in blocks[k]}
        if not placement:
            continue
        rows.append(
            {
                "symbol": symbol,
                "name": q.get("name") or info.get("name", symbol),
                "sector": info.get("sector", ""),
                "industry": info.get("industry", ""),
                "idx": "400" if symbol in core_at[as_of] else "500",
                "m12": round(long_leg[0], 6),
                "m6": round(mid_leg[0], 6),
                "vol12": round(long_leg[1], 6),
                "vol6": round(mid_leg[1], 6),
                "va12": round(long_leg[2], 4),
                "va6": round(mid_leg[2], 4),
                "price": q.get("price") or round(index_maps[symbol][1][-1], 2),
                "chg": round(q["changePercentage"], 2) if q.get("changePercentage") is not None else None,
                "mktCap": q.get("marketCap") or universes.cap_at(caps, symbol, as_of),
                "yearHigh": q.get("yearHigh"),
                "yearLow": q.get("yearLow"),
                "r": placement,
            }
        )
    log(f"ranked {len(rows)} names as of {as_of}")

    core_priced = len(core_at[as_of] & set(prices))
    guard(core_priced >= 380, f"only {core_priced} of the MidCap 400 priced")
    guard(len(members_at[as_of]) >= 620, f"universe is only {len(members_at[as_of])} names")
    previous = DATA / "latest.json"
    if previous.exists():
        before = len(json.loads(previous.read_text())["rows"])
        guard(len(rows) >= 0.95 * before, f"ranked {len(rows)} names, down from {before} last run")
    guard(len(kept_dates) >= HISTORY_MONTHS - 1, f"only {len(kept_dates)} monthly cross-sections")

    counts = {key: sum(1 for r in rows if key in r["r"]) for key in PEER_SETS}
    meta_block = {
        "asOf": as_of,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "fromCore": len(core_at[as_of] & set(prices)),
        "members": len(members_at[as_of]),
        "counts": counts,
        "sizeTail": universes.SIZE_TAIL,
        "params": {
            "skipDays": SKIP_DAYS,
            "longDays": LONG_DAYS,
            "midDays": MID_DAYS,
            "weights": [WEIGHT_LONG, WEIGHT_MID],
            "minSector": MIN_SECTOR,
            "historyMonths": len(kept_dates),
            "historyWeeks": len(kept_weeks),
        },
    }
    write_json(DATA / "latest.json", {"meta": meta_block, "rows": rows})

    published = {r["symbol"] for r in rows}
    for source, outside, dates, suffix in (
        (history, history_outside, kept_dates, ""),
        (weekly, weekly_outside, kept_weeks, "w"),
    ):
        for key in PEER_SETS:
            scores = {
                symbol: [by_date.get(d) for d in dates]
                for symbol, by_date in source[key].items()
                if symbol in published
            }
            # Bar indices scored as an outsider, only for names that have any.
            pre = {
                symbol: [i for i, d in enumerate(dates) if d in when]
                for symbol, when in outside[key].items()
                if symbol in published and when
            }
            write_json(DATA / "history" / f"{key}{suffix}.json",
                       {"dates": dates, "scores": scores, "outside": pre})

    # The list rows draw a one-year strip per name. That ships one file per peer
    # set rather than all of them together: the list only ever draws the active
    # set, and eight sets in one payload would be most of the home screen's
    # weight spent on seven the reader cannot see. Integer scores for the last
    # SPARK_MONTHS month-ends, only names in the published rows; outsider
    # indices are relative to the strip, not the full history.
    (DATA / "spark").mkdir(exist_ok=True)
    strip = kept_dates[-SPARK_MONTHS:]
    for key in PEER_SETS:
        write_json(DATA / "spark" / f"{key}.json", {
            "dates": strip,
            "scores": {
                symbol: [None if by_date.get(d) is None else round(by_date[d]) for d in strip]
                for symbol, by_date in history[key].items()
                if symbol in published
            },
            "outside": {
                symbol: [i for i, d in enumerate(strip) if d in when]
                for symbol, when in history_outside[key].items()
                if symbol in published and any(d in when for d in strip)
            },
        })


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    log(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
