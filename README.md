# MidCap 650 Momentum

A phone-first momentum ranking of roughly 650 US mid-sized stocks, published as a static site on
GitHub Pages and refreshed every weekday morning by a GitHub Action. Alongside it, and outside it,
a research section holds the backtests and prototype indicators.

**Live:** https://vandyckmed-droid.github.io/400/ · research: https://vandyckmed-droid.github.io/400/research/

This file is the source of truth for the project's current state. `CLAUDE.md` covers how to work
with the owner.

## What the product does

- Ranks every name in the universe by price momentum and shows the list, sortable and filterable,
  with a watchlist and search.
- Each name has a detail page: its placement against the whole universe and within its sector, a
  history chart of its score at each month end (36) or week end (78), and a full-screen price chart.
- A settings page holds two settings (see below), the methodology, a data card, and the one link
  the app carries to the research section.
- Installable to the iOS home screen as a standalone app.

The app is deliberately only that. Whether the score has been worth following, and every other
reading of the universe, lives in `research/` (see **Research** below): published by the same
site, never loaded by the app, and refreshed on demand rather than daily.

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
3. **Optional adjustment**: each leg is either left as the return, divided by the annualised
   standard deviation of daily log returns over its own window, or replaced by the return net of
   the market (see below).
4. **Percentile**: each leg is ranked 0–100 against the peer set (average ranks for ties).
5. **Blend**: final score = 0.5 × 12–1 percentile + 0.5 × 6–1 percentile.

A name needs at least 180 daily returns in the 12-month window and 90 in the 6-month window, so
recent listings sit out until they season.

### The six peer sets

Two settings change how the one cross-section is read, never which names are in it. Both persist
per device in local storage.

| Setting | Choices |
| --- | --- |
| Score within sector (switch) | Off: rank against the whole universe (`w`). On: rank only against the name's GICS sector (`s`) |
| What each leg measures (three-way) | The return itself (`r`, default); return ÷ its own volatility (`v`); return net of the market (`m`) |

The combination is a two-letter key: `wr`, `wv`, `wm`, `sr`, `sv`, `sm`. All six ship in every
ranking file. Sectors with fewer than five names would be left unscored, but none currently are.

**Net of the market** means residual momentum: over each formation window the name's daily log
returns are regressed on the equal-weight average of every priced name, and the leg becomes the
return that regression leaves unexplained (the intercept times the number of days). It stops
rewarding names that merely rode the market. Over five years of point-in-time testing it beat the
plain ranking on return, volatility and drawdown while sharing about 85% of its names; the
volatility option gave a calmer ride at a similar return.

Sector labels are normalised to GICS names. FMP labels S&P 500 sectors with a different taxonomy
("Technology", "Healthcare"); `scripts/universes.py` maps those onto the GICS names Wikipedia uses
for the MidCap 400, otherwise names would be ranked against their data source instead of their sector.

### Recent joiners

A name that joined the index recently is scored on earlier dates as an "outsider": inserted into
that day's member distribution to find where it would have ranked, without changing the members'
own percentiles. Those bars are dimmed on the chart and labelled "not yet a member". The research
backtests never use outsider scores.

## Research

`research/` is a standalone reference: plain pages with their own stylesheet and scripts, served
by the same GitHub Pages site at `/research/`, but not part of the app. The app loads nothing from
it and carries exactly one link to it, at the foot of the methodology in Settings. The old in-app
`#/evidence` route redirects there. `research/README.md` describes the section in full; in short:

- **Evidence** (`research/evidence.html`): what holding the top decile would have done, month by
  month, against every ranked name, on all three leg measures; forward returns by decile, spread,
  hit rate, sector concentration and caveats. Built by `research/scripts/backtest.py` and
  `research/scripts/portfolio.py`, which import the momentum maths from `scripts/build.py` so the
  test and the live ranking cannot diverge. Whole-universe rankings only; within-sector is untested.
- **Oscillator studies** (`research/oscillator/`): the textbook per-stock oscillators tested against
  six years of the universe (none predicts anything useful), a reading derived from the data with
  no formula assumed (per stock it rediscovers momentum), and two universe-level readings that do
  carry information: 63-day breadth and the share of names near their yearly lows, each with a
  phone page and, for the near-lows share, an interactive two-pane chart.
- **Moving-average cross study** (`research/ma-cross/`): 254 crossover pairs searched over six
  years for the durations that best time each name's peaks and valleys. None beats holding, the
  profit ordering reverses between the bear and bull halves, and the only stable result is that
  EMA 40/60 marks 20% turns most reliably, about five weeks after the fact. Its `README.md` has
  the design, the trade-off ladder and the verdict; no page, just the report.

The research numbers are a snapshot. They are refreshed only by the manual **Refresh research**
workflow (see Automation), never by the daily job, and every page states the dates it covers.

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

data/latest.json                   current ranking, all six peer sets, quotes, key stats (~330 KB)
data/spark/<key>.json              last 12 month-end scores per name, one file per peer set (6)
data/history/<key>.json            36 month-end scores per name, one file per peer set (6)
data/history/<key>w.json           78 week-end scores per name, loaded only when asked for
data/bars/<SYMBOL>.json            756 adjusted daily bars per ranked name (~19 MB in all)
data/universe.json                 MidCap 400 constituents + change log; also the offline fallback
data/sp500.json                    S&P 500 constituents + change log; also the offline fallback

research/index.html  research.css  the research front page and the section's own stylesheet
research/evidence.html  evidence.js  the top-decile record: self-contained, incl. its chart code
research/scripts/backtest.py       decile forward-return test  → research/data/backtest.json
research/scripts/portfolio.py      daily top-decile portfolio curves → research/data/portfolio.json
research/oscillator/               the oscillator studies: scripts, results, reports, pages
research/ma-cross/                 the moving-average cross study: script, results, report
research/README.md                 what the section is and how to refresh it

.github/workflows/refresh.yml      weekday-morning rebuild of data/ + commit
.github/workflows/research.yml     manual-only rerun of research/ + commit
```

### App routes

The app is a single page routed by URL hash: the list at `/`, a ticker at `#/t/SYMBOL`, its price
chart at `#/t/SYMBOL/chart`, and `#/settings`; `#/evidence` redirects to the research section.
Files beyond the ranking are fetched lazily and memoised; a failed optional fetch leaves that piece
out rather than breaking the page. Watchlist, sector filter, both settings and the chart interval
persist in local storage.

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
weekday close. It runs `scripts/build.py` and commits `data/` if anything changed. The script exits
non-zero on a degraded result, which stops the job before the commit. A market holiday yields
identical scores, but the run still commits because every payload carries its generation
timestamp; that is what keeps the staleness banner quiet over a long weekend.

On-demand rebuild: **Actions → Refresh momentum data → Run workflow**.

`.github/workflows/research.yml` has no schedule. **Actions → Refresh research → Run workflow**
reruns the backtest, the portfolio curves, both oscillator studies and the moving-average cross
study against the vendor's six-year history and commits `research/` if anything changed. It never touches `data/`.

Publishing is GitHub Pages serving the `main` branch root directly. There is no deploy workflow;
every push to `main`, including the daily data commit, republishes the site.

### One-time setup already done

- Repository secret `FMP_API_KEY` for the workflow.
- Pages configured to deploy from branch `main`, folder `/ (root)`. This cannot be set from CI.

### Running locally

```sh
FMP_API_KEY=your_key python3 scripts/build.py              # the app's data
FMP_API_KEY=your_key python3 research/scripts/backtest.py  # the research section, as needed
FMP_API_KEY=your_key python3 research/scripts/portfolio.py
FMP_API_KEY=your_key python3 research/oscillator/oscillator.py
FMP_API_KEY=your_key python3 research/oscillator/derived.py
FMP_API_KEY=your_key python3 research/ma-cross/ma_cross.py
python3 -m http.server 8000        # then open http://localhost:8000 and /research/
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
- **The app and the research section are separate on purpose.** The app carries one link to the
  research front page and nothing else: no card, no numbers, no fetch. Research pages copy the
  chart code and styles they need rather than sharing the app's, so neither side can break the
  other. Keep it that way: a research finding that should become a feature goes through `build.py`
  and the app, not through a link.
- **Research data is a snapshot.** It updates only when someone runs the research workflow. A page
  that shows research numbers must show its dates.

## Not investment advice

A percentile is a rank against peers, not a return forecast.
