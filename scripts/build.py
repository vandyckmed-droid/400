#!/usr/bin/env python3
"""Build the S&P MidCap 400 momentum ranking data files.

Pipeline
--------
1. Resolve the current S&P MidCap 400 universe (Wikipedia, with a committed
   snapshot as fallback).
2. Pull ~5 years of dividend/split-adjusted daily closes per ticker from FMP.
3. At each month-end snapshot, compute volatility-adjusted 12-1 and 6-1
   momentum, convert each leg to a cross-sectional 0-100 percentile, and blend
   the two 50/50.
4. Emit data/latest.json (current ranking + key stats) and data/history.json
   (blended score through time, shared date axis).

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
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from bisect import bisect_right
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
YEARS_OF_PRICES = 6     # history depth to request from FMP
MIN_NAMES_PER_SNAPSHOT = 50   # skip cross-sections thinner than this
WEIGHT_LONG = 0.5       # 12-1 weight in the blend
WEIGHT_MID = 0.5        # 6-1 weight in the blend

WORKERS = 8
RETRIES = 4
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
            time.sleep(2 ** attempt)
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


def load_universe() -> list[dict]:
    snapshot = DATA / "universe.json"
    try:
        universe = scrape_universe()
        log(f"universe: {len(universe)} constituents from Wikipedia")
        snapshot.write_text(
            json.dumps(
                {"asOf": dt.date.today().isoformat(), "constituents": universe},
                indent=1,
            )
            + "\n"
        )
        return universe
    except Exception as exc:  # noqa: BLE001 - degrade to the committed snapshot
        if not snapshot.exists():
            raise
        log(f"universe: scrape failed ({exc}); using committed snapshot")
        return json.loads(snapshot.read_text())["constituents"]


# --- 2. Prices ----------------------------------------------------------------

def fetch_prices(symbol: str, start: str) -> list[tuple[str, float]]:
    """Adjusted daily closes, oldest first. Cached on disk between runs."""
    cache_file = CACHE / f"{symbol}.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 12 * 3600:
        return [tuple(x) for x in json.loads(cache_file.read_text())]
    rows = fmp("historical-price-eod/dividend-adjusted", symbol=symbol, **{"from": start})
    series = [
        (r["date"], float(r["adjClose"]))
        for r in rows
        if isinstance(r, dict) and r.get("adjClose") not in (None, 0)
    ]
    series.sort()
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(series))
    return series


def fetch_all_prices(symbols: list[str]) -> dict[str, list[tuple[str, float]]]:
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * YEARS_OF_PRICES))).isoformat()
    prices: dict[str, list[tuple[str, float]]] = {}
    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_prices, s, start): s for s in symbols}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            symbol = futures[future]
            try:
                series = future.result()
                if len(series) > LONG_DAYS:
                    prices[symbol] = series
                else:
                    failures.append(symbol)
            except Exception as exc:  # noqa: BLE001
                failures.append(symbol)
                log(f"  prices failed for {symbol}: {exc}")
            if done % 50 == 0:
                log(f"  prices {done}/{len(symbols)}")
    if failures:
        log(f"prices: {len(failures)} symbols without usable history: {', '.join(sorted(failures)[:15])}")
    return prices


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


def month_end_dates(calendar: list[str], count: int) -> list[str]:
    """The last trading day of each of the most recent `count` complete months."""
    by_month: dict[str, str] = {}
    for date in calendar:
        by_month[date[:7]] = date          # calendar is sorted, so this keeps the last
    months = sorted(by_month)
    if months and months[-1][:7] == dt.date.today().strftime("%Y-%m"):
        months.pop()                        # drop the in-progress month
    return [by_month[m] for m in months[-count:]]


def snapshot(prices, index_maps, date, universe_meta):
    """Compute one cross-section. Returns (rows, blended scores by symbol)."""
    legs: dict[str, dict] = {}
    for symbol, series in prices.items():
        dates, closes = index_maps[symbol]
        pos = bisect_right(dates, date) - 1
        if pos < 0:
            continue
        long_leg = vol_adjusted_momentum(closes, pos, LONG_DAYS, MIN_OBS_LONG)
        mid_leg = vol_adjusted_momentum(closes, pos, MID_DAYS, MIN_OBS_MID)
        if not long_leg or not mid_leg:
            continue
        legs[symbol] = {"long": long_leg, "mid": mid_leg, "pos": pos}

    if len(legs) < MIN_NAMES_PER_SNAPSHOT:
        return [], {}

    pct_long = percentiles({s: v["long"][2] for s, v in legs.items()})
    pct_mid = percentiles({s: v["mid"][2] for s, v in legs.items()})
    blended = {
        s: WEIGHT_LONG * pct_long[s] + WEIGHT_MID * pct_mid[s] for s in legs
    }

    rows = []
    for symbol, leg in legs.items():
        meta = universe_meta.get(symbol, {})
        rows.append(
            {
                "symbol": symbol,
                "name": meta.get("name", symbol),
                "sector": meta.get("sector", ""),
                "industry": meta.get("industry", ""),
                "score": round(blended[symbol], 2),
                "p12": round(pct_long[symbol], 2),
                "p6": round(pct_mid[symbol], 2),
                "m12": round(leg["long"][0], 6),
                "m6": round(leg["mid"][0], 6),
                "vol12": round(leg["long"][1], 6),
                "vol6": round(leg["mid"][1], 6),
                "va12": round(leg["long"][2], 4),
                "va6": round(leg["mid"][2], 4),
            }
        )
    rows.sort(key=lambda r: -r["score"])
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    return rows, blended


# --- 4. Assemble --------------------------------------------------------------

def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    universe = load_universe()
    universe_meta = {c["symbol"]: c for c in universe}
    symbols = sorted(universe_meta)

    log(f"fetching {YEARS_OF_PRICES}y of adjusted prices for {len(symbols)} symbols")
    prices = fetch_all_prices(symbols)
    log(f"prices: {len(prices)} usable series")

    index_maps = {s: ([d for d, _ in v], [c for _, c in v]) for s, v in prices.items()}

    # Trading calendar = every date seen across the universe.
    calendar = sorted({d for series in prices.values() for d, _ in series})
    snapshot_dates = month_end_dates(calendar, HISTORY_MONTHS)
    as_of = calendar[-1]
    log(f"as of {as_of}; {len(snapshot_dates)} monthly snapshots from {snapshot_dates[0]}")

    history_scores: dict[str, list] = {s: [None] * len(snapshot_dates) for s in prices}
    kept_dates: list[str] = []
    for i, date in enumerate(snapshot_dates):
        _, blended = snapshot(prices, index_maps, date, universe_meta)
        if not blended:
            continue
        kept_dates.append(date)
        for symbol in prices:
            value = blended.get(symbol)
            history_scores[symbol][i] = round(value, 1) if value is not None else None
    keep_idx = [snapshot_dates.index(d) for d in kept_dates]
    history_scores = {
        s: [v[i] for i in keep_idx] for s, v in history_scores.items()
    }

    # The live cross-section uses the latest trading day, not a month end.
    rows, _ = snapshot(prices, index_maps, as_of, universe_meta)
    log(f"ranked {len(rows)} names as of {as_of}")

    quotes = fetch_quotes([r["symbol"] for r in rows])
    for row in rows:
        q = quotes.get(row["symbol"], {})
        closes = index_maps[row["symbol"]][1]
        row["price"] = q.get("price") or round(closes[-1], 2)
        row["chg"] = round(q["changePercentage"], 2) if q.get("changePercentage") is not None else None
        row["mktCap"] = q.get("marketCap")
        row["yearHigh"] = q.get("yearHigh")
        row["yearLow"] = q.get("yearLow")
        if q.get("name"):
            row["name"] = q["name"]

    # Drop history for names that fell out of the ranking.
    ranked = {r["symbol"] for r in rows}
    history_scores = {s: v for s, v in history_scores.items() if s in ranked}

    meta = {
        "asOf": as_of,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "universeSize": len(universe),
        "ranked": len(rows),
        "params": {
            "skipDays": SKIP_DAYS,
            "longDays": LONG_DAYS,
            "midDays": MID_DAYS,
            "weights": [WEIGHT_LONG, WEIGHT_MID],
            "historyMonths": len(kept_dates),
        },
    }

    write_json(DATA / "latest.json", {"meta": meta, "rows": rows})
    write_json(DATA / "history.json", {"dates": kept_dates, "scores": history_scores})
    log("wrote data/latest.json and data/history.json")


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    log(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
