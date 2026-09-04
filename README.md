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
scripts/backtest.py              point-in-time membership + forward-return test
data/backtest.json               decile returns, spreads and the spread time series
.github/workflows/refresh.yml    weekly rebuild + commit
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

The site is plain static files at the repository root, so Pages serves it directly from the branch —
no deploy workflow, no build step.

**One-time setup:** *Settings → Pages → Build and deployment* → source **Deploy from a branch**,
branch **`main`**, folder **`/ (root)`**. GitHub's built-in `pages-build-deployment` then republishes
on every push to `main`, including the weekly data commit.

This toggle cannot be set from CI: `POST /repos/{owner}/{repo}/pages` requires a token with the
`pages` scope, and neither the Actions `GITHUB_TOKEN` (`Resource not accessible by integration`) nor
an automation environment can create the site. It is a one-time click.

Locally:

```sh
FMP_API_KEY=your_key python3 scripts/build.py   # ~15s for 400 tickers
python3 -m http.server 8000                     # then open http://localhost:8000
```

Responses are cached under `.cache/` (gitignored) for 12 hours, so re-runs while iterating are
instant.

## Does the score actually predict anything?

`scripts/backtest.py` answers that honestly. It rebuilds month-by-month index membership by
walking Wikipedia's *Selected changes* table backwards from today's list (399–402 members at every
month end, ~3.4 additions/month), re-ranks only the names alive on each date, and measures forward
returns. It imports `build.py` for the momentum maths, so the test and the site cannot diverge.

The results are in the app too, at `#/evidence` — reachable from the methodology dialog, the
footer, and a decile tag on every ticker page. Over 36 month ends (Mar 2023 – Feb 2026),
equal-weighted:

| Horizon | Top decile | Bottom decile | Spread | Hit rate | Non-overlapping t |
| --- | --- | --- | --- | --- | --- |
| 1 month | +1.50% | +0.53% | +0.97% | 53% | 1.21 (n=36) |
| 3 months | +6.09% | +1.47% | +4.62% | 78% | 1.65 (n=12) |
| 6 months | +12.32% | +2.83% | +9.49% | 78% | 2.02 (n=6) |

Mean return falls almost monotonically from D1 to D10 (rank correlation −0.93), which matters more
than any single bucket: the whole ranking is ordered, not just its ends.

**Read the caveats with the table.** Sampling 3- and 6-month returns monthly makes the windows
overlap, so the naive t-stats (3.18 and 4.10) are inflated; the honest counts are 12 and 6
independent windows. The sample is three years of a mostly rising market — every decile is positive
at 6 months — and the 6-month spread decays across it: +12.0% for 2023 ranking dates, +10.8% for
2024, +7.6% for 2025. This is evidence the ranking is ordered, not proof it will pay.

Using today's membership instead of point-in-time *understates* the 6-month spread (+6.5% vs
+9.3%), because names dropped from the index are disproportionately the losers that belong in the
bottom decile. Delisted names are held to their last print and then treated as cash; that path
affects 0.03% of observations, so acquisition premia don't move the result.

## Not investment advice

A percentile is a rank against peers, not a return forecast.
