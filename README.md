# MidCap 650 Momentum

A phone-first momentum ranking of roughly 650 US mid-sized stocks, published as a static site on
GitHub Pages and refreshed every weekday morning by a GitHub Action.

**Live:** https://vandyckmed-droid.github.io/400/

This file is the source of truth for the project's current state. `CLAUDE.md` covers how to work
with the owner.

## What the product does

- Ranks every name in the universe by price momentum and shows the list, sortable and filterable,
  with a watchlist and search.
- Each name has a detail page: its placement against the whole universe and within its sector, a
  history chart of its score at each month end (36) or week end (78), and a full-screen price chart.
- An evidence page shows what the score has been worth: a point-in-time backtest by decile and a
  daily equal-weight top-decile portfolio curve, with caveats.
- A settings page holds two switches (see below), the methodology, and a data card.
- Installable to the iOS home screen as a standalone app.

Everything is computed server-side by Python scripts and served as static JSON. The browser does
no math beyond drawing. The Financial Modeling Prep (FMP) API key never reaches the browser.

## The universe

There is exactly one universe and it is not a setting:

- the S&P MidCap 400 as it stood on the day, plus
- the 250 smallest S&P 500 members by that day's market cap (the "tail").

The 400/500 boundary is an index-committee decision, not an economic one, so the tail lets a name
be ranked against everything of roughly its size. Tail names are badged "500" in the list.
Membership and market caps are both point-in-time, so a historical cross-section uses the universe
as it stood that day.

The earlier design that offered the universe as a switch was removed deliberately. Every published
name is a member of every peer set, so there is no "not in this universe" state anywhere in the app.

**Known limitation.** Names that have since left the index are absent from older cross-sections,
so historical bars carry some survivorship bias. Present-day rankings are unaffected.

## The score

For each name, on each ranking date:

1. **12–1 momentum**: total return on dividend- and split-adjusted closes over the 252 trading days
   ending 21 trading days ago. The last month is skipped to avoid short-term reversal.
2. **6–1 momentum**: the same over 126 trading days, again ending 21 days ago.
3. **Optional volatility adjustment**: each leg divided by the annualised standard deviation of
   daily log returns over its own window.
4. **Percentile**: each leg is ranked 0–100 against the peer set (average ranks for ties).
5. **Blend**: final score = 0.5 × 12–1 percentile + 0.5 × 6–1 percentile.

A name needs at least 180 daily returns in the 12-month window and 90 in the 6-month window, so
recent listings sit out until they season.

### The four peer sets

Two switches in Settings change how the one cross-section is read, never which names are in it.
Both persist per device in local storage.

| Switch | Off (default) | On |
| --- | --- | --- |
| Score within sector | Rank against the whole universe (`w`) | Rank only against the name's GICS sector (`s`) |
| Divide each leg by its volatility | Rank the return itself (`r`) | Rank return ÷ volatility (`v`) |

The combination is a two-letter key: `wr`, `wv`, `sr`, `sv`. All four ship in every ranking file.
Sectors with fewer than five names would be left unscored, but none currently are.

Sector labels are normalised to GICS names. FMP labels S&P 500 sectors with a different taxonomy
("Technology", "Healthcare"); `scripts/universes.py` maps those onto the GICS names Wikipedia uses
for the MidCap 400, otherwise names would be ranked against their data source instead of their sector.

### Recent joiners

A name that joined the index recently is scored on earlier dates as an "outsider": inserted into
that day's member distribution to find where it would have ranked, without changing the members'
own percentiles. Those bars are dimmed on the chart and labelled "not yet a member". The backtest
and portfolio never use outsider scores.

## Evidence

Both evidence scripts import the momentum maths from `scripts/build.py`, so the test and the live
site cannot diverge. Both rank the whole universe only; the within-sector basis is untested.

- **Backtest** (`scripts/backtest.py`): at each of the last 36 usable month ends, rebuild
  point-in-time membership, rank, split into deciles, and measure 1-, 3- and 6-month forward
  returns. Reports decile means, top-minus-bottom spread, hit rate, and t-statistics with the
  overlap correction. Delisted names are held at their last print and then treated as cash.
- **Portfolio** (`scripts/portfolio.py`): buy the top decile equally weighted at each month end,
  hold untouched until the next, repeat for up to 48 months. Records a daily NAV for the top
  decile, bottom decile and the whole universe equally weighted (the benchmark), plus return,
  volatility, drawdown, and sector concentration (Herfindahl and effective number of sectors) at
  each rebalance. No costs or taxes, so every figure is better than real life.

The evidence page reads the numbers from the data files, so it never carries a stale claim. As of
September 2026 the honest summary is: the ranking is ordered (returns fall almost monotonically
from decile 1 to 10), the top decile beats the equal-weight universe by well under a point a year
while carrying more risk, and the return-ranked top decile is concentrated in roughly 5.4 effective
sectors against 8.5 for the universe. Volatility adjustment spreads it to about 6.2 and cuts
drawdown more than it changes return.

## How it is built

### Files

```
index.html  styles.css  app.js     the site: vanilla JS, no build step, no dependencies
chart.js                           the price chart: canvas bars, pan / pinch / axis-stretch,
                                   200-day linear regression channel
chart.html                         legacy redirect into the in-app chart view
manifest.webmanifest  icon-*.png   home-screen install

scripts/build.py                   the whole ranking pipeline, standard library only
scripts/universes.py               universe definition, point-in-time membership, market caps
scripts/backtest.py                decile forward-return test
scripts/portfolio.py               daily top-decile portfolio curves

data/latest.json                   current ranking, all four peer sets, quotes, key stats (~330 KB)
data/spark/<key>.json              last 12 month-end scores per name, one file per peer set
data/history/<key>.json            36 month-end scores per name, one file per peer set
data/history/<key>w.json           78 week-end scores per name, loaded only when asked for
data/bars/<SYMBOL>.json            756 adjusted daily bars per ranked name (~19 MB in all)
data/backtest.json                 decile returns, spreads, per-year breakdown, both rankings
data/portfolio.json                daily NAV curves, stats, sector mix at each rebalance
data/portfolio-brief.json          headline portfolio numbers, small enough to load with the list
data/universe.json                 MidCap 400 constituents + change log; also the offline fallback
data/sp500.json                    S&P 500 constituents + change log; also the offline fallback

.github/workflows/refresh.yml      weekday-morning rebuild + commit
```

### App routes

The app is a single page routed by URL hash: the list at `/`, a ticker at `#/t/SYMBOL`, its price
chart at `#/t/SYMBOL/chart`, `#/evidence`, and `#/settings`. Files beyond the ranking are fetched
lazily and memoised; a failed optional fetch leaves that piece out rather than breaking the page.
Watchlist, sector filter, both switches and the chart interval persist in local storage.

### Data sources

All from FMP except the MidCap 400 list, which no FMP plan tier exposes:

| Data | Source |
| --- | --- |
| MidCap 400 members and change log | Scraped from Wikipedia's *List of S&P 400 companies* |
| S&P 500 members and change log | FMP `sp500-constituent` and `historical-sp500-constituent` |
| Market caps (to pick the tail, point-in-time) | FMP `historical-market-capitalization` |
| Prices and bars | FMP `historical-price-eod/dividend-adjusted`, 6 years, ~1,100 symbols |
| Quotes (market cap, 52-week range, last change) | FMP `batch-quote` |

Responses are cached under `.cache/` (gitignored) for 12 hours, so local re-runs are fast and a
failed run does not re-pay for what already succeeded.

### Safeguards

- **Sources down.** Each membership source writes a committed snapshot on success and falls back
  to it on failure, so an outage degrades the refresh to the last good membership.
- **Degraded output.** `build.py` refuses to publish if fewer than 380 of the 400 priced, the
  universe is under 620 names, the ranked count fell more than 5% from last run, or a monthly
  cross-section went missing. The vendor throttles in alphabetical blocks, and a partial outage
  would otherwise commit a quietly wrong ranking.
- **Intraday prints.** A bar dated today is dropped when the run happens before 21:00 UTC, so a
  manual daytime run never plots an unsettled close.
- **Stale data.** If the published data is more than four days old the list shows an amber banner.
- **Reproducibility.** Ties and set iteration are sorted deterministically, so identical inputs
  produce byte-identical files and the job does not commit no-op diffs.

## Automation

`.github/workflows/refresh.yml` runs Tuesday to Saturday at 10:00 UTC, the morning after each
weekday close. It runs the three scripts in order (ranking, backtest, portfolio) and commits
`data/` if anything changed. Each script exits non-zero on a degraded result, which stops the job
before the commit. A market holiday yields identical scores, but the run still commits because
every payload carries its generation timestamp; that is what keeps the staleness banner quiet over
a long weekend.

On-demand rebuild: **Actions → Refresh momentum data → Run workflow**.

Publishing is GitHub Pages serving the `main` branch root directly. There is no deploy workflow;
every push to `main`, including the daily data commit, republishes the site.

### One-time setup already done

- Repository secret `FMP_API_KEY` for the workflow.
- Pages configured to deploy from branch `main`, folder `/ (root)`. This cannot be set from CI.

### Running locally

```sh
FMP_API_KEY=your_key python3 scripts/build.py
python3 scripts/backtest.py
python3 scripts/portfolio.py
python3 -m http.server 8000        # then open http://localhost:8000
```

## Things that affect future work

- **No dependencies anywhere.** The scripts use only the Python standard library and the site is
  plain HTML, CSS and JS. Adding a package or a build step is a real decision, not a detail.
- **Everything is pre-computed.** A new feature that needs a number the JSON does not carry means a
  change to `build.py` and a refresh, not a browser-side calculation.
- **Repository size grows daily.** The bars folder is rewritten on every run; git stores each
  rewrite as a small delta, but the history is still growing.
- **The universe is fixed by design.** Re-introducing a universe switch was tried and removed
  because it created a "not in this universe" state throughout the app.
- **Sector-relative and within-sector portfolios are untested.** Presenting them as evidence would
  need their own backtest.
- **Minor stale wording remains** in `index.html` (the list footer still says "within the current
  S&P MidCap 400") and in `manifest.webmanifest` (the description still says "volatility-adjusted"
  and "MidCap 400"). Neither affects behaviour.

## Not investment advice

A percentile is a rank against peers, not a return forecast.
