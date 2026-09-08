#!/usr/bin/env python3
"""Build the momentum ranking data files.

Pipeline
--------
1. Resolve the universe with point-in-time membership (universes.py): the
   S&P 500 and the S&P MidCap 400 together, ~900 names. Each source falls
   back to a committed snapshot if it is down.
2. Pull ~6 years of dividend/split-adjusted daily closes per ticker from FMP.
3. On every trading day of the last three years, compute the 9-1 legs once
   per name (return, volatility, return net of the market, residual
   volatility), then take the measure each of the app's four adjustments
   picks. The measure is the score: there is no standardisation step.
4. Refuse to publish if the result looks degraded (guard()), else emit
   data/latest.json (today's legs, from which the browser scores the list),
   data/score/<key>.json (per day: member count and the ladder of member
   scores) and data/spark/<key>.json.
5. Write data/bars/<SYMBOL>.json for every published name: the adjusted daily
   bars the price chart draws plus the name's legs on the same dates.

Only the standard library is used, so the refresh job needs no dependencies.
"""

from __future__ import annotations

import base64
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
import struct
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
# Same layout, same GICS labels: the source of every S&P 500 name's sector and
# sub-industry, so both halves of the universe are labelled from one list.
WIKI_SP500 = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
# The change log lived on that page until September 2026, when editors moved it
# here. Both are read, so a move back costs nothing.
WIKI_CHANGES = "https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_400"

# --- Ranking parameters -------------------------------------------------------
# Trading-day windows. 21d ~ 1 month, 252d ~ 12 months.
SKIP_DAYS = 21          # the "-1" in 9-1: skip the most recent month
WINDOW_DAYS = 189       # 9-month formation window
MIN_OBS = 135           # min daily returns required in the 9-1 window
BETA_DAYS = 756         # rolling window for a name's market beta (~3 years), ending on the day
MIN_OBS_BETA = 252      # min daily returns in that window before a beta is trusted
SPARK_MONTHS = 12       # month-end scores drawn as a strip in each list row
YEARS_OF_PRICES = 6     # history depth to request from FMP
BARS_DAYS = 756         # ~3 trading years of daily bars, and daily scores, per name
MIN_NAMES_PER_SNAPSHOT = 50   # skip cross-sections thinner than this

# Cleanliness: what keeps a member out of a day's cross-section.
MIN_HISTORY = 504       # bars of trading history before a name is scored (~2 years), so a
                        # 12-month window never starts inside a new listing's first months
MIN_VOL = 0.08          # annualised 12-month volatility below this means the name is not
                        # trading on its own merits (a pending takeover), so it is left out
VOL_DAYS = 63           # the list's volatility: the most recent 63 trading days, no skip

# The score is the 9-1 window's measure itself, under one of four adjustments,
# each published so the app can switch between them without a rebuild:
#   none      the return
#   vol       the return over its own volatility
#   resid     net of the market: the return minus beta times the market's,
#             beta from a rolling three-year regression on the equal-weight
#             universe as it stood each day
#   volresid  net of the market, over the residual volatility
# There is no standardisation step, so the score is a return (or a return per
# unit of risk), not a z-score. How it is displayed (value, rank, percentile)
# is a reading of the same number and needs nothing extra published.
ADJUSTS = ("none", "vol", "resid", "volresid")
KEYS = list(ADJUSTS)
SCALE = 1_000_000       # the ladder's fixed point: the six decimals the legs carry

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


def scrape_universe(url: str = WIKI) -> list[dict]:
    """Symbol, name, GICS sector and GICS sub-industry from a Wikipedia index
    list page: the MidCap 400 by default, the S&P 500 for its labels."""
    page = http_get(url).decode("utf-8", "replace")
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
    raise RuntimeError(f"could not locate the constituents table on {url.rsplit('/', 1)[-1]}")


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(text).replace(" ", " ").strip()


def snapshot(name: str, fetch, describe: str) -> dict:
    """Fetch fresh and persist to data/<name>.json, or fall back to the committed
    copy if the source is down. A vendor or Wikipedia outage then degrades the
    refresh to the last successful run's membership instead of failing it outright."""
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
        and r["date"] != UNSETTLED_TODAY
    )
    return series if len(series) > WINDOW_DAYS else []


def fetch_bars(symbol: str, start: str) -> list[tuple[str, float, float, float, float]]:
    """Adjusted daily bars (date, open, high, low, close), oldest first, for the
    price chart. Reads the payload fetch_prices already cached for this symbol,
    so the chart costs no extra vendor calls."""
    rows = cached_fmp(
        f"px-{symbol}", "historical-price-eod/dividend-adjusted",
        symbol=symbol, **{"from": start},
    )
    bars = []
    for r in rows:
        if (not isinstance(r, dict) or r.get("adjClose") in (None, 0)
                or r["date"] == UNSETTLED_TODAY):
            continue
        close = float(r["adjClose"])
        if r.get("adjOpen") is not None:
            o, h, l = r["adjOpen"], r["adjHigh"], r["adjLow"]
        elif r.get("open") is not None and r.get("close"):
            # A safety net, not the live path: this endpoint serves adjOpen /
            # adjHigh / adjLow today. If it ever returns raw open/high/low
            # instead, scale them by the factor the close got rather than
            # drawing bars on a different basis from the close.
            f = close / float(r["close"])
            o, h, l = r["open"] * f, r["high"] * f, r["low"] * f
        else:
            o = h = l = close
        bars.append((r["date"], round(float(o), 2), round(float(h), 2),
                     round(float(l), 2), round(close, 2)))
    bars.sort()
    return bars[-BARS_DAYS:]


# The vendor serves today's bar during the session as though it were a close.
# Run before 21:00 UTC (the US close is 20:00) and a bar dated today is an
# intraday print, which would otherwise become the last plotted value. The
# scheduled run is at 10:00 UTC, hours before any session opens, so it never
# sees one; this covers a manual run during the day.
_now = dt.datetime.now(dt.timezone.utc)
UNSETTLED_TODAY = _now.date().isoformat() if _now.hour < 21 else None


def trading_days(prices: dict[str, list[tuple[str, float]]]) -> list[str]:
    """The calendar the whole universe trades on: dates with a bar for at least
    half the priced names. A union of every series would let one stray bar —
    a stale listing, a foreign holiday print — add a day on which everything
    else merely carries its previous value."""
    count: dict[str, int] = {}
    for series in prices.values():
        for d, _ in series:
            count[d] = count.get(d, 0) + 1
    floor = len(prices) / 2
    return sorted(d for d, n in count.items() if n >= floor)


def make_index_maps(prices: dict[str, list[tuple[str, float]]], members_at: dict[str, set[str]]) -> dict:
    """Per symbol: (dates, closes, and prefix sums for the window maths).

    The market is the investable universe: the equal-weight average of the
    names that were index members on each day (`members_at`), rebalanced
    daily. For each symbol the market's log return is measured between that
    symbol's own consecutive bars, so a name with a missing day is regressed
    on the market over the same gap. Prefix sums of the stock's log return (y),
    the market's (x), x*x, x*y and y*y make the regression, and both
    volatilities, over any window O(1).
    """
    calendar = trading_days(prices)
    market = cum_series(prices, calendar, members_at)
    cum_at = cum_lookup(market, calendar)

    out = {}
    for symbol, series in prices.items():
        dates = [d for d, _ in series]
        closes = [c for _, c in series]
        px, py, pxx, pxy, pyy = [0.0], [0.0], [0.0], [0.0], [0.0]
        prev_m = market.get(dates[0], cum_at(dates[0]))
        for i in range(1, len(dates)):
            m = market.get(dates[i], cum_at(dates[i]))
            x = m - prev_m
            y = math.log(closes[i] / closes[i - 1])
            prev_m = m
            px.append(px[-1] + x); py.append(py[-1] + y)
            pxx.append(pxx[-1] + x * x); pxy.append(pxy[-1] + x * y); pyy.append(pyy[-1] + y * y)
        out[symbol] = (dates, closes, px, py, pxx, pxy, pyy)
    return out


def cum_series(prices: dict, calendar: list[str], members_at: dict[str, set[str]] | None = None) -> dict[str, float]:
    """Cumulative log return of the equal-weight average of `prices`, rebalanced
    daily, keyed by date: the market when given the universe, an industry when
    given a group. With `members_at`, only that day's members count."""
    at = {s: dict(v) for s, v in prices.items()}
    cum = [0.0]
    for prev, cur in zip(calendar, calendar[1:]):
        today = members_at.get(cur) if members_at is not None else None
        rets = [m[cur] / m[prev] - 1.0 for s, m in at.items()
                if cur in m and prev in m and (today is None or s in today)]
        cum.append(cum[-1] + math.log1p(sum(rets) / len(rets)) if rets else cum[-1])
    return dict(zip(calendar, cum))


def cum_lookup(series: dict[str, float], calendar: list[str]):
    """A date -> cumulative value function that carries the last value forward."""
    cum = [series[d] for d in calendar]

    def at(date: str) -> float:
        i = bisect_right(calendar, date) - 1
        return cum[i] if i >= 0 else 0.0
    return at


def price_start() -> str:
    return (dt.date.today() - dt.timedelta(days=int(365.25 * YEARS_OF_PRICES))).isoformat()


def fetch_all_prices(symbols: list[str]) -> dict[str, list[tuple[str, float]]]:
    start = price_start()
    return gather(symbols, lambda s: fetch_prices(s, start), "prices")


def write_bars(symbols: list[str], legs: dict) -> None:
    """One compact file of daily bars per published name, columnar so the chart
    can index straight into it, plus the name's 9-1 legs on the same
    dates (`legs[symbol][date]`, null where it has none), so the chart can
    score any day under any setting with nothing to align. Rewritten whole on
    every run; git stores the rewrite as a delta against the previous version,
    so a day's growth is a few hundred bytes per name, not a fresh copy."""
    folder = DATA / "bars"
    folder.mkdir(exist_ok=True)
    start = price_start()
    bars = gather(symbols, lambda s: fetch_bars(s, start), "bars")
    for symbol, series in bars.items():
        dates = [b[0] for b in series]
        mine = legs.get(symbol, {})
        payload = {
            "symbol": symbol,
            "asOf": series[-1][0],
            "adjusted": "dividends and splits",
            "dates": dates,
            "o": [b[1] for b in series],
            "h": [b[2] for b in series],
            "l": [b[3] for b in series],
            "c": [b[4] for b in series],
            "legs": {name: [None if d not in mine else mine[d][i] for d in dates]
                     for i, name in enumerate(LEG_NAMES)},
        }
        (folder / f"{symbol}.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    # A name that left the published set leaves the chart too.
    for stale in folder.glob("*.json"):
        if stale.stem not in bars:
            stale.unlink()
    size = sum(f.stat().st_size for f in folder.glob("*.json"))
    log(f"  data/bars/  {len(bars)} files  {size / 1024 / 1024:.1f} MB")


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

LEG_NAMES = ("r", "v", "e", "w")   # return, volatility, net-of-market return, residual volatility


def leg_at(entry: tuple, end: int, lookback: int, min_obs: int):
    """One formation window's ingredients, or None where the window is short
    or degenerate: (return, annualised volatility, return net of the market,
    annualised volatility of the residual returns), each rounded to six
    decimals so this script and the browser start from identical numbers.

    `end` indexes the most recent bar at or before the snapshot date. The
    window runs from `end - lookback` to `end - SKIP_DAYS`, so the most recent
    month is excluded (the "-1" in 9-1). Net of the market: the
    window's log return minus beta times the market's, where beta comes from
    `beta_at` (the rolling three-year regression ending on the day); the
    residual volatility is that of the daily residuals y - beta * x over the
    window."""
    _, closes, px, py, pxx, pxy, pyy = entry
    stop, start = end - SKIP_DAYS, end - lookback
    n = stop - start
    if start < 0 or n < min_obs:
        return None
    p0, p1 = closes[start], closes[stop]
    if p0 <= 0 or p1 <= 0:
        return None
    beta = beta_at(entry, end)
    if beta is None:
        return None
    raw = p1 / p0 - 1.0
    sx, sy = px[stop] - px[start], py[stop] - py[start]
    sxx, sxy, syy = pxx[stop] - pxx[start], pxy[stop] - pxy[start], pyy[stop] - pyy[start]
    var = (syy - sy * sy / n) / (n - 1)
    if var <= 1e-12:
        return None
    resid = sy - beta * sx
    rsq = syy - 2.0 * beta * sxy + beta * beta * sxx        # sum of squared residuals
    rvar = max(rsq - resid * resid / n, 0.0) / (n - 1)
    if rvar <= 1e-12:
        return None
    return (round(raw, 6), round(math.sqrt(var * 252.0), 6),
            round(resid, 6), round(math.sqrt(rvar * 252.0), 6))


def beta_at(entry: tuple, end: int):
    """The name's market beta on the day: the slope of its daily log returns on
    the equal-weight universe's over the BETA_DAYS ending at `end` (or as much
    of that as the name has traded, MIN_OBS_BETA at least). None where the
    history is too short or the market did not move."""
    _, _, px, py, pxx, pxy, _ = entry
    start = max(0, end - BETA_DAYS)
    n = end - start
    if n < MIN_OBS_BETA:
        return None
    sx, sy = px[end] - px[start], py[end] - py[start]
    sxx, sxy = pxx[end] - pxx[start], pxy[end] - pxy[start]
    denom = n * sxx - sx * sx
    if denom <= 1e-12:
        return None
    return (n * sxy - sx * sy) / denom


def recent_vol(entry: tuple, days: int = VOL_DAYS):
    """Annualised volatility of the name's last `days` daily log returns, to
    the latest bar, with no skipped month: the list's risk figure. None with
    too little history."""
    _, _, _, py, _, _, pyy = entry
    end = len(py) - 1
    start = end - days
    if start < 0:
        return None
    sy, syy = py[end] - py[start], pyy[end] - pyy[start]
    var = (syy - sy * sy / days) / (days - 1)
    return round(math.sqrt(max(var, 0.0) * 252.0), 6)


def legs_at(symbols, index_maps, date: str) -> dict:
    """The 9-1 legs for every name in `symbols` that is scorable at `date`, as
    {symbol: leg}: at least MIN_HISTORY bars of history by then, the window
    complete, and a window volatility of at least MIN_VOL. Sorted, so
    everything downstream is the same on every run."""
    out = {}
    for symbol in sorted(symbols):
        entry = index_maps.get(symbol)
        if not entry:
            continue
        pos = bisect_right(entry[0], date) - 1
        if pos + 1 < MIN_HISTORY:
            continue
        leg = leg_at(entry, pos, WINDOW_DAYS, MIN_OBS)
        if leg and leg[1] >= MIN_VOL:
            out[symbol] = leg
    return out


# --- Momentum decomposition ---------------------------------------------------
# For one industry group so far: 9-1 momentum raw, net of the market (the
# same rolling beta the score uses), and net of the market and the group by an
# in-window regression, so the reader sees how much of the move the name's
# environment explains.

DECOMP_GROUP = ("Regional banks", ("Regional Banks",))


def decompose(symbol: str, entry: tuple, prices: dict, group: list[str], calendar: list[str], end: int):
    """Raw 9-1 return, the return net of the market (the leg's own residual,
    beta from `beta_at`, so the two agree), and the return net of the market
    and the group: the group is the equal-weight average of the other members,
    with its market component removed in-window before it is used."""
    dates, closes, px, py, pxx, pxy, _ = entry
    stop, start = end - SKIP_DAYS, end - WINDOW_DAYS
    n = stop - start
    beta = beta_at(entry, end)
    if start < 0 or n < MIN_OBS or beta is None:
        return None
    others = {s: prices[s] for s in group if s != symbol and s in prices}
    if len(others) < 2:
        return None
    grp = cum_lookup(cum_series(others, calendar), calendar)
    xs = [px[i] - px[i - 1] for i in range(start + 1, stop + 1)]
    ys = [py[i] - py[i - 1] for i in range(start + 1, stop + 1)]
    gs = [grp(dates[i]) - grp(dates[i - 1]) for i in range(start + 1, stop + 1)]

    def slope(a, b):
        ma, mb = sum(a) / n, sum(b) / n
        return sum((u - ma) * (v - mb) for u, v in zip(a, b)) / sum((u - ma) ** 2 for u in a)
    zs = [g - slope(xs, gs) * x for g, x in zip(gs, xs)]     # the group net of the market
    # two regressors with an intercept
    mx, mz, my = sum(xs) / n, sum(zs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); szz = sum((z - mz) ** 2 for z in zs); sxz = sum((x - mx) * (z - mz) for x, z in zip(xs, zs))
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys)); szy = sum((z - mz) * (y - my) for z, y in zip(zs, ys))
    det = sxx * szz - sxz * sxz
    if det <= 1e-18:
        return None
    b_m2 = (sxy * szz - szy * sxz) / det; b_i = (szy * sxx - sxy * sxz) / det
    return {
        "raw": round(closes[stop] / closes[start] - 1.0, 6),
        "mkt": round(sum(y - beta * x for x, y in zip(xs, ys)), 6),
        "ind": round(sum(y - b_m2 * x - b_i * z for x, y, z in zip(xs, ys, zs)), 6),
        "betaM": round(beta, 3), "betaI": round(b_i, 3),
    }


# --- 4. The score -------------------------------------------------------------
# app.js carries the same arithmetic on the same rounded inputs, so the list it
# scores in the browser and the daily series published here agree to the last
# digit.

def measure(leg: tuple, adjust: str) -> float:
    """What the window measures under an adjustment: the score itself."""
    raw, vol, resid, rvol = leg
    if adjust == "none":
        return raw
    if adjust == "vol":
        return raw / vol
    if adjust == "resid":
        return resid
    return resid / rvol


def quant(v: float) -> int:
    """The score as the fixed-point integer the ladder is built from, the same
    way in Python and JavaScript, so a rank never turns on a last-bit
    difference between the two."""
    return math.floor(v * SCALE + 0.5)


def cross_section(legs: dict, members: set) -> tuple[dict, dict]:
    """Score every name in `legs` on one date, against the members.

    Returns (scores, ladder):
      scores[key][symbol] = the score as its fixed-point integer,
      ladder[key] = the members' scores as ascending ints — the cross-section
        the app ranks any name against.
    A name outside the members (a recent joiner, on an earlier date) is scored
    without entering the ladder."""
    scores, ladder = {}, {}
    for adjust in KEYS:
        per = {s: quant(measure(leg, adjust)) for s, leg in legs.items()}
        scores[adjust] = per
        ladder[adjust] = sorted(per[s] for s in members if s in per)
    return scores, ladder


def rank_in(ladder: list[int], scaled: int) -> int:
    """Position among the members, 1 = best; ties share the better position."""
    return 1 + len(ladder) - bisect_right(ladder, scaled)


def pack(ints: list[int]) -> str:
    """A ladder as base64 little-endian int32. Wider than the old two-decimal
    z-scores needed, because the score is now a return: at six decimals ~900
    names keep their own place instead of sharing manufactured ties."""
    return base64.b64encode(struct.pack(f"<{len(ints)}i", *ints)).decode("ascii")


def month_end_dates(calendar: list[str], count: int) -> list[str]:
    """The last trading day of each of the most recent `count` complete months."""
    by_month: dict[str, str] = {}
    for date in calendar:
        by_month[date[:7]] = date          # calendar is sorted, so this keeps the last
    months = sorted(by_month)
    if months and months[-1][:7] == dt.date.today().strftime("%Y-%m"):
        months.pop()                        # drop the in-progress month
    return [by_month[m] for m in months[-count:]]


# --- Assemble -----------------------------------------------------------------

def main() -> None:
    import universes

    DATA.mkdir(parents=True, exist_ok=True)

    core_universe, core_changes = universes.load_core()
    sp500_universe, sp500_changes = universes.load_sp500()
    log(f"universes: {len(core_universe)} MidCap 400, {len(sp500_universe)} S&P 500; "
        f"change logs {len(core_changes)} / {len(sp500_changes)}")

    meta = {c["symbol"]: c for c in core_universe}
    for c in sp500_universe:
        meta.setdefault(c["symbol"], c)
    core_now = {c["symbol"] for c in core_universe}
    sp500_now = {c["symbol"] for c in sp500_universe}

    # One line per company: where two share classes are both members, only
    # the Class A share is kept, on every date.
    second_class = universes.second_classes(core_universe + sp500_universe)
    if second_class:
        log(f"share classes left out: {', '.join(sorted(second_class))}")
    core_now -= second_class
    sp500_now -= second_class

    window_start = price_start()
    ever = set(core_now) | set(sp500_now)
    for change in core_changes + sp500_changes:
        if change["date"] >= window_start and change["removed"]:
            ever.add(change["removed"])
    ever -= second_class
    log(f"pricing {len(ever)} symbols (current members plus former ones within the price history)")

    prices = fetch_all_prices(sorted(ever))
    calendar = trading_days(prices)
    as_of = calendar[-1]
    daily_dates = calendar[-BARS_DAYS:]          # one cross-section per bar the chart shows
    spark_dates = set(month_end_dates(calendar, SPARK_MONTHS))
    log(f"as of {as_of}; scoring {len(daily_dates)} trading days from {daily_dates[0]}")

    # The universe: the S&P 500 and the MidCap 400, each as it stood that day,
    # over the whole price history so the market benchmark behind every beta
    # window is the index of its day, not today's survivors.
    core_at = universes.membership_history(core_now, core_changes, calendar)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, calendar)
    members_at = {}
    for date in calendar:
        members_at[date] = (core_at[date] | sp500_at[date]) & set(prices)
    index_maps = make_index_maps(prices, members_at)
    log(f"universe today: {len(members_at[as_of])} names "
        f"({len(core_at[as_of] & set(prices))} from the MidCap 400 + "
        f"{len(members_at[as_of]) - len(core_at[as_of] & set(prices))} from the S&P 500)")

    # --- every day's cross-section, under every setting ---
    legs_now = legs_at(members_at[as_of], index_maps, as_of)
    live = set(legs_now)                          # every name the site will publish
    per_day = []                                  # (date, ladder) in order
    daily_legs = {}                               # symbol -> {date: leg}
    spark = {key: {"dates": [], "n": [], "s": {}, "k": {}} for key in KEYS}
    for date in daily_dates:
        legs = legs_at(members_at[date] | live, index_maps, date)
        members = {s for s in legs if s in members_at[date]}
        if len(members) < MIN_NAMES_PER_SNAPSHOT:
            continue
        scores, ladder = cross_section(legs, members)
        per_day.append((date, ladder))
        for s, leg in legs.items():
            if s in live:
                daily_legs.setdefault(s, {})[date] = leg
        if date in spark_dates:
            for key in KEYS:
                sp = spark[key]
                sp["dates"].append(date)
                sp["n"].append(len(ladder[key]))
                for s in live:
                    v = scores[key].get(s)
                    sp["s"].setdefault(s, []).append(v)
                    sp["k"].setdefault(s, []).append(None if v is None else rank_in(ladder[key], v))
    kept_days = [d for d, _ in per_day]
    log(f"scored {len(kept_days)} of {len(daily_dates)} trading days")

    ranked = sorted(legs_now)
    unscored = sorted(members_at[as_of] - live)
    log(f"members not scored today: {', '.join(unscored) or 'none'}")
    group_name, labels = DECOMP_GROUP
    group = sorted(s for s in ranked if meta.get(s, {}).get("industry", "") in labels)
    decomp = {}
    for s in group:
        entry = index_maps[s]
        d = decompose(s, entry, prices, group, calendar, bisect_right(entry[0], as_of) - 1)
        if d:
            decomp[s] = d
    log(f"momentum decomposition: {len(decomp)} {group_name.lower()}")
    quotes = fetch_quotes(ranked)
    rows = []
    for symbol in ranked:
        leg = legs_now[symbol]
        info = meta.get(symbol, {})
        q = quotes.get(symbol, {})
        rows.append(
            {
                "symbol": symbol,
                "name": q.get("name") or info.get("name", symbol),
                "sector": info.get("sector", ""),
                "industry": info.get("industry", ""),
                "legs": dict(zip(LEG_NAMES, leg)),
                "vol63": recent_vol(index_maps[symbol]),
                **({"decomp": decomp[symbol]} if symbol in decomp else {}),
                "price": q.get("price") or round(index_maps[symbol][1][-1], 2),
                "chg": round(q["changePercentage"], 2) if q.get("changePercentage") is not None else None,
                "mktCap": q.get("marketCap"),
                "yearHigh": q.get("yearHigh"),
                "yearLow": q.get("yearLow"),
            }
        )
    log(f"ranked {len(rows)} names as of {as_of}")

    core_priced = len(core_at[as_of] & set(prices))
    guard(core_priced >= 380, f"only {core_priced} of the MidCap 400 priced")
    guard(len(members_at[as_of]) >= 850, f"universe is only {len(members_at[as_of])} names")
    previous = DATA / "latest.json"
    if previous.exists():
        before = len(json.loads(previous.read_text())["rows"])
        guard(len(rows) >= 0.95 * before, f"ranked {len(rows)} names, down from {before} last run")
    guard(len(kept_days) >= BARS_DAYS - 5, f"only {len(kept_days)} daily cross-sections")
    guard(kept_days[-1] == as_of, "no cross-section on the as-of date")

    meta_block = {
        "asOf": as_of,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "fromCore": core_priced,
        "members": len(members_at[as_of]),
        # Cleanliness: the share classes left out, and today's members that
        # did not clear the history or volatility bar.
        "excluded": {"shareClass": sorted(second_class), "unscored": unscored},
        "decomp": {"group": group_name, "symbols": group},
        "keys": KEYS,
        "params": {
            "skipDays": SKIP_DAYS,
            "windowDays": WINDOW_DAYS,
            "betaDays": BETA_DAYS,
            "scale": SCALE,
            "minHistory": MIN_HISTORY,
            "minVol": MIN_VOL,
            "volDays": VOL_DAYS,
            "dailyDays": len(kept_days),
            "sparkMonths": SPARK_MONTHS,
        },
    }
    write_json(DATA / "latest.json", {"meta": meta_block, "rows": rows})

    # One file per score definition: for every day, how many members were
    # scored and the ladder of member scores. With a name's legs from its bar
    # file that is the whole daily series, in any display.
    (DATA / "score").mkdir(exist_ok=True)
    for key in KEYS:
        write_json(DATA / "score" / f"{key}.json", {
            "key": key, "adjust": key,
            "dates": kept_days,
            "n": [len(ladder[key]) for _, ladder in per_day],
            "ladder": [pack(ladder[key]) for _, ladder in per_day],
        })

    # The list rows draw a year of month-end standings per name: the score and
    # the rank at each, from which the percentile follows. One file per score
    # definition so the list only ever downloads the active one.
    (DATA / "spark").mkdir(exist_ok=True)
    for key in KEYS:
        write_json(DATA / "spark" / f"{key}.json", spark[key])
    # A definition that no longer exists leaves the site with it.
    for folder in ("score", "spark"):
        for stale in (DATA / folder).glob("*.json"):
            if stale.stem not in KEYS:
                stale.unlink()

    write_bars(sorted(live), daily_legs)


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    log(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
