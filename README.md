# MidCap 400 Momentum

A phone-first ranking of the S&P MidCap 400 by **volatility-adjusted momentum**, published as a
static site on GitHub Pages.

**Live:** https://vandyckmed-droid.github.io/400/

## The score

For every constituent, on every ranking date:

| Step | What happens |
| --- | --- |
| 12–1 momentum | Total return on dividend- and split-adjusted closes over the 12 months ending **one month ago** (252 → 21 trading days back). The last month is skipped to avoid short-term reversal. |
| 6–1 momentum | The same over the trailing 6 months (126 → 21 trading days back). |
| Volatility adjustment | Each leg is divided by the annualised standard deviation of daily log returns measured over that same formation window. A steady climb outranks an equally large but erratic one. |
| Cross-sectional percentile | Each leg is ranked against every other MidCap 400 name on that date and mapped to 0–100 (average ranks, so ties share a percentile). |
| Blend | **Final score = 0.5 × 12–1 percentile + 0.5 × 6–1 percentile.** |

A name needs a full 12-month window (≥ 180 daily returns) and a full 6-month window (≥ 90) to be
ranked, so very recent index additions sit out until they season.

The **history chart** re-runs the entire cross-section at each of the last 36 month ends, so a bar
shows where a name stood *against its peers on that date* — not a rescaling of today's numbers.

### Known limitation

The peer set is today's index membership at every historical date. Names that have since left the
index are absent from older cross-sections, so historical bars carry some survivorship bias. Fixing
this properly needs point-in-time constituent snapshots, which the current data plan doesn't expose.
Present-day rankings are unaffected.

## Layout

```
index.html  styles.css  app.js   the site (vanilla JS, no build step, no dependencies)
data/latest.json                 current ranking + key stats  (~128 KB)
data/history.json                blended score per month end, shared date axis  (~73 KB)
data/universe.json               constituent snapshot, also the offline fallback
scripts/build.py                 the whole pipeline, standard library only
.github/workflows/refresh.yml    weekly rebuild + commit
.github/workflows/pages.yml      publishes the repo root to Pages on every push to main
```

The API key never reaches the browser: everything is computed server-side in the refresh job and
served as static JSON.

## Data

- **Universe** — scraped from Wikipedia's *List of S&P 400 companies* (there is no MidCap 400
  constituent endpoint on this FMP plan). Each successful scrape rewrites `data/universe.json`,
  which doubles as the fallback if the scrape ever fails.
- **Prices** — FMP `stable/historical-price-eod/dividend-adjusted`, 6 years per ticker.
- **Quotes** — FMP `stable/batch-quote` for market cap, 52-week range and last change.

## Refreshing

Automatic: `.github/workflows/refresh.yml` runs Saturdays at 12:00 UTC and commits `data/` if
anything changed. Momentum on 12- and 6-month windows barely moves intraday, so weekly is the right
cadence; use **Actions → Refresh momentum data → Run workflow** for an on-demand rebuild.

**One-time setup:** add the FMP key as a repository secret named `FMP_API_KEY`
(*Settings → Secrets and variables → Actions*). Without it the scheduled job fails and the site
keeps serving the last committed data.

## Publishing

`.github/workflows/pages.yml` uploads the repository root to GitHub Pages on every push to `main`.
It passes `enablement: true` to `actions/configure-pages`, so the first run turns Pages on by
itself — there is no Settings toggle to flip — and each weekly data commit redeploys the site.

Locally:

```sh
FMP_API_KEY=your_key python3 scripts/build.py   # ~15s for 400 tickers
python3 -m http.server 8000                     # then open http://localhost:8000
```

Responses are cached under `.cache/` (gitignored) for 12 hours, so re-runs while iterating are
instant.

## Not investment advice

A percentile is a rank against peers, not a return forecast.
