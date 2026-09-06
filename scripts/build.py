#!/usr/bin/env python3
"""Build the momentum ranking data files.

Pipeline
--------
1. Resolve the universe with point-in-time membership (universes.py): the
   S&P 500 and the S&P MidCap 400 together, ~900 names. Each source falls
   back to a committed snapshot if it is down.
2. Pull ~6 years of dividend/split-adjusted daily closes per ticker from FMP.
3. On every trading day of the last three years, compute the 12-1 and 6-1
   legs once per name (return, volatility, return net of the market, residual
   volatility), then score them under every setting the app offers: each
   period's measure standardised (z-scored) against the whole universe or the
   name's sector, and the two periods blended 50/50 or taken alone.
4. Refuse to publish if the result looks degraded (guard()), else emit
   data/latest.json (today's legs and peer statistics, from which the browser
   scores the list), data/score/<key>.json (per day: member count, peer
   statistics, and the ladder of member scores) and data/spark/<key>.json.
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
# The change log lived on that page until September 2026, when editors moved it
# here. Both are read, so a move back costs nothing.
WIKI_CHANGES = "https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_400"

# --- Ranking parameters -------------------------------------------------------
# Trading-day windows. 21d ~ 1 month, 252d ~ 12 months.
SKIP_DAYS = 21          # the "-1" in 12-1 / 6-1: skip the most recent month
LONG_DAYS = 252         # 12-month formation window
MID_DAYS = 126          # 6-month formation window
MIN_OBS_LONG = 180      # min daily returns required in the 12-1 window
MIN_OBS_MID = 90        # min daily returns required in the 6-1 window
SPARK_MONTHS = 12       # month-end scores drawn as a strip in each list row
YEARS_OF_PRICES = 6     # history depth to request from FMP
BARS_DAYS = 756         # ~3 trading years of daily bars, and daily scores, per name
MIN_NAMES_PER_SNAPSHOT = 50   # skip cross-sections thinner than this
MIN_SECTOR = 5          # smallest sector a name can be standardised against

# The score is one definition with four choices, and every combination is
# published so the app can switch between them without a rebuild:
#   period   12-1, 6-1, or a 50/50 blend of the two
#   adjust   the return itself; over its own volatility; net of the market;
#            or net of the market over the residual volatility
#   basis    standardised (z-scored) against the whole universe or the name's
#            own GICS sector
# The fourth choice, how the score is displayed (value, rank, percentile), is
# a reading of the completed score and needs nothing extra published.
PERIODS = ("12", "6", "blend")
ADJUSTS = ("none", "vol", "resid", "volresid")
BASES = ("universe", "sector")
KEYS = [f"{p}-{a}-{b}" for p in PERIODS for a in ADJUSTS for b in BASES]
LEG_INDEX = {"12": 0, "6": 1}

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
    return series if len(series) > LONG_DAYS else []


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


def make_index_maps(prices: dict[str, list[tuple[str, float]]]) -> dict:
    """Per symbol: (dates, closes, and prefix sums for the window maths).

    The market is the equal-weight average of every priced name, rebalanced
    daily. For each symbol the market's log return is measured between that
    symbol's own consecutive bars, so a name with a missing day is regressed
    on the market over the same gap. Prefix sums of the stock's log return (y),
    the market's (x), x*x, x*y and y*y make the regression, and both
    volatilities, over any window O(1).
    """
    calendar = trading_days(prices)
    at = {s: dict(v) for s, v in prices.items()}
    cum = [0.0]
    for prev, cur in zip(calendar, calendar[1:]):
        rets = [m[cur] / m[prev] - 1.0 for m in at.values() if cur in m and prev in m]
        cum.append(cum[-1] + math.log1p(sum(rets) / len(rets)) if rets else cum[-1])
    market = dict(zip(calendar, cum))

    def cum_at(date: str) -> float:
        i = bisect_right(calendar, date) - 1
        return cum[i] if i >= 0 else 0.0

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


def price_start() -> str:
    return (dt.date.today() - dt.timedelta(days=int(365.25 * YEARS_OF_PRICES))).isoformat()


def fetch_all_prices(symbols: list[str]) -> dict[str, list[tuple[str, float]]]:
    start = price_start()
    return gather(symbols, lambda s: fetch_prices(s, start), "prices")


def write_bars(symbols: list[str], legs: dict) -> None:
    """One compact file of daily bars per published name, columnar so the chart
    can index straight into it, plus the name's two momentum legs on the same
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
            "legs": {
                f"{name}{period}": [None if d not in mine else mine[d][LEG_INDEX[period]][i] for d in dates]
                for period in ("12", "6")
                for i, name in enumerate(LEG_NAMES)
            },
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
    month is excluded (the "-1" in 12-1 / 6-1). Net of the market: the name's
    daily log returns are regressed on the equal-weight universe's with an
    intercept; the residual return is the intercept times the number of days,
    the window's return net of beta times the market's; the residual
    volatility is that of what the regression leaves over."""
    _, closes, px, py, pxx, pxy, pyy = entry
    stop, start = end - SKIP_DAYS, end - lookback
    n = stop - start
    if start < 0 or n < min_obs:
        return None
    p0, p1 = closes[start], closes[stop]
    if p0 <= 0 or p1 <= 0:
        return None
    raw = p1 / p0 - 1.0
    sx, sy = px[stop] - px[start], py[stop] - py[start]
    sxx, sxy, syy = pxx[stop] - pxx[start], pxy[stop] - pxy[start], pyy[stop] - pyy[start]
    var = (syy - sy * sy / n) / (n - 1)
    if var <= 1e-12:
        return None
    denom = n * sxx - sx * sx
    if denom <= 1e-12:
        return None
    beta = (n * sxy - sx * sy) / denom
    alpha = (sy - beta * sx) / n
    rvar = max(syy - alpha * sy - beta * sxy, 0.0) / (n - 1)
    if rvar <= 1e-12:
        return None
    return (round(raw, 6), round(math.sqrt(var * 252.0), 6),
            round(sy - beta * sx, 6), round(math.sqrt(rvar * 252.0), 6))


def legs_at(symbols, index_maps, date: str) -> dict:
    """The 12-1 and 6-1 legs for every name in `symbols` with enough history
    at `date`, as {symbol: (leg12, leg6)}. Sorted, so everything downstream
    is the same on every run."""
    out = {}
    for symbol in sorted(symbols):
        entry = index_maps.get(symbol)
        if not entry:
            continue
        pos = bisect_right(entry[0], date) - 1
        if pos < 0:
            continue
        long_leg = leg_at(entry, pos, LONG_DAYS, MIN_OBS_LONG)
        mid_leg = leg_at(entry, pos, MID_DAYS, MIN_OBS_MID)
        if long_leg and mid_leg:
            out[symbol] = (long_leg, mid_leg)
    return out


# --- 4. The score -------------------------------------------------------------
# app.js carries the same three steps in the same order, on the same rounded
# inputs, so the list it scores in the browser and the daily series published
# here agree to the last digit.

def measure(leg: tuple, adjust: str) -> float:
    """What one period measures under an adjustment."""
    raw, vol, resid, rvol = leg
    if adjust == "none":
        return raw
    if adjust == "vol":
        return raw / vol
    if adjust == "resid":
        return resid
    return resid / rvol


def round2(v: float) -> float:
    """Two decimals, the same way in Python and JavaScript."""
    return math.floor(v * 100 + 0.5) / 100


def cross_section(legs: dict, members: set, meta: dict) -> tuple[dict, dict, dict]:
    """Score every name in `legs` on one date, against the members.

    Returns (stats, scores, ladder):
      stats[period][adjust][group] = (mean, sd) over the members of the group
        ("*" is the universe; a sector appears only with MIN_SECTOR members),
      scores[key][symbol] = the completed score, None where unscored,
      ladder[key] = the members' scores x 100 as ascending ints — the
        cross-section the app ranks any name against.
    A name outside the members (a recent joiner, on an earlier date) is scored
    against the members' statistics without entering them."""
    groups = {"*": [s for s in legs if s in members]}
    for s in groups["*"]:
        sector = meta.get(s, {}).get("sector", "")
        if sector:
            groups.setdefault(sector, []).append(s)
    groups = {g: m for g, m in groups.items() if g == "*" or len(m) >= MIN_SECTOR}
    xs, stats = {}, {}
    for period in ("12", "6"):
        stats[period] = {}
        for adjust in ADJUSTS:
            x = {s: measure(legs[s][LEG_INDEX[period]], adjust) for s in legs}
            xs[period, adjust] = x
            stats[period][adjust] = {}
            for g, m in groups.items():
                vals = [x[s] for s in m]
                mu = sum(vals) / len(vals)
                sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals))
                stats[period][adjust][g] = (round(mu, 6), round(sd, 6))

    def z(s, period, adjust, basis):
        g = "*" if basis == "universe" else meta.get(s, {}).get("sector", "")
        st = stats[period][adjust].get(g)
        if st is None:
            return None
        mu, sd = st
        return round2((xs[period, adjust][s] - mu) / sd) if sd > 0 else 0.0

    scores, ladder = {}, {}
    for key in KEYS:
        period, adjust, basis = key.split("-")
        per = {}
        for s in legs:
            if period == "blend":
                a, b = z(s, "12", adjust, basis), z(s, "6", adjust, basis)
                per[s] = None if a is None or b is None else round2((a + b) / 2)
            else:
                per[s] = z(s, period, adjust, basis)
        scores[key] = per
        ladder[key] = sorted(int(round(per[s] * 100)) for s in members if per.get(s) is not None)
    return stats, scores, ladder


def rank_in(ladder: list[int], score: float) -> int:
    """Position among the members, 1 = best; ties share the better position."""
    return 1 + len(ladder) - bisect_right(ladder, int(round(score * 100)))


def pack(ints: list[int]) -> str:
    """A ladder as base64 little-endian int16, a third the size of JSON."""
    return base64.b64encode(struct.pack(f"<{len(ints)}h", *ints)).decode("ascii")


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

    window_start = (dt.date.today() - dt.timedelta(days=365 * 4)).isoformat()
    ever = set(core_now) | set(sp500_now)
    for change in core_changes + sp500_changes:
        if change["date"] >= window_start and change["removed"]:
            ever.add(change["removed"])
    log(f"pricing {len(ever)} symbols (current members plus former ones still in window)")

    prices = fetch_all_prices(sorted(ever))
    index_maps = make_index_maps(prices)
    calendar = trading_days(prices)
    as_of = calendar[-1]
    daily_dates = calendar[-BARS_DAYS:]          # one cross-section per bar the chart shows
    spark_dates = set(month_end_dates(calendar, SPARK_MONTHS))
    log(f"as of {as_of}; scoring {len(daily_dates)} trading days from {daily_dates[0]}")

    core_at = universes.membership_history(core_now, core_changes, daily_dates)
    sp500_at = universes.membership_history(sp500_now, sp500_changes, daily_dates)

    # The universe: the S&P 500 and the MidCap 400, each as it stood that day.
    members_at = {}
    for date in daily_dates:
        members_at[date] = (core_at[date] | sp500_at[date]) & set(prices)
    log(f"universe today: {len(members_at[as_of])} names "
        f"({len(core_at[as_of] & set(prices))} from the MidCap 400 + "
        f"{len(members_at[as_of]) - len(core_at[as_of] & set(prices))} from the S&P 500)")

    # --- every day's cross-section, under every setting ---
    legs_now = legs_at(members_at[as_of], index_maps, as_of)
    live = set(legs_now)                          # every name the site will publish
    per_day = []                                  # (date, stats, ladder) in order
    daily_legs = {}                               # symbol -> {date: (leg12, leg6)}
    spark = {key: {"dates": [], "n": [], "s": {}, "k": {}} for key in KEYS}
    asof_stats = None
    for date in daily_dates:
        legs = legs_at(members_at[date] | live, index_maps, date)
        members = {s for s in legs if s in members_at[date]}
        if len(members) < MIN_NAMES_PER_SNAPSHOT:
            continue
        stats, scores, ladder = cross_section(legs, members, meta)
        per_day.append((date, stats, ladder))
        for s, pair in legs.items():
            if s in live:
                daily_legs.setdefault(s, {})[date] = pair
        if date == as_of:
            asof_stats = stats
        if date in spark_dates:
            for key in KEYS:
                sp = spark[key]
                sp["dates"].append(date)
                sp["n"].append(len(ladder[key]))
                for s in live:
                    v = scores[key].get(s)
                    sp["s"].setdefault(s, []).append(None if v is None else int(round(v * 100)))
                    sp["k"].setdefault(s, []).append(None if v is None else rank_in(ladder[key], v))
    kept_days = [d for d, _, _ in per_day]
    log(f"scored {len(kept_days)} of {len(daily_dates)} trading days")

    ranked = sorted(legs_now)
    quotes = fetch_quotes(ranked)
    rows = []
    for symbol in ranked:
        long_leg, mid_leg = legs_now[symbol]
        info = meta.get(symbol, {})
        q = quotes.get(symbol, {})
        rows.append(
            {
                "symbol": symbol,
                "name": q.get("name") or info.get("name", symbol),
                "sector": info.get("sector", ""),
                "industry": info.get("industry", ""),
                "legs": {f"{name}{period}": leg[i]
                         for period, leg in (("12", long_leg), ("6", mid_leg))
                         for i, name in enumerate(LEG_NAMES)},
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
    guard(asof_stats is not None, "no cross-section on the as-of date")

    meta_block = {
        "asOf": as_of,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "fromCore": core_priced,
        "members": len(members_at[as_of]),
        "keys": KEYS,
        "params": {
            "skipDays": SKIP_DAYS,
            "longDays": LONG_DAYS,
            "midDays": MID_DAYS,
            "minSector": MIN_SECTOR,
            "dailyDays": len(kept_days),
            "sparkMonths": SPARK_MONTHS,
        },
        # The as-of date's peer statistics: with the rows' legs, enough for
        # the browser to build every score itself.
        "stats": asof_stats,
    }
    write_json(DATA / "latest.json", {"meta": meta_block, "rows": rows})

    # One file per score definition: for every day, how many members were
    # scored, the peer statistics of the groups it standardises against, and
    # the ladder of member scores. With a name's legs from its bar file that
    # is the whole daily series, in any display.
    (DATA / "score").mkdir(exist_ok=True)
    for key in KEYS:
        period, adjust, basis = key.split("-")
        periods = ("12", "6") if period == "blend" else (period,)
        groups = sorted({g for _, st, _ in per_day for p in periods for g in st[p][adjust]
                         if (g == "*") == (basis == "universe")})
        write_json(DATA / "score" / f"{key}.json", {
            "key": key, "period": period, "adjust": adjust, "basis": basis,
            "dates": kept_days,
            "n": [len(ladder[key]) for _, _, ladder in per_day],
            "stats": {g: {p: [st[p][adjust].get(g) for _, st, _ in per_day] for p in periods}
                      for g in groups},
            "ladder": [pack(ladder[key]) for _, _, ladder in per_day],
        })

    # The list rows draw a year of month-end standings per name: the score and
    # the rank at each, from which the percentile follows. One file per score
    # definition so the list only ever downloads the active one.
    (DATA / "spark").mkdir(exist_ok=True)
    for key in KEYS:
        write_json(DATA / "spark" / f"{key}.json", spark[key])

    write_bars(sorted(live), daily_legs)


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    log(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
