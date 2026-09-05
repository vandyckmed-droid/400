# MidCap 650 Momentum

A phone-first momentum ranking of roughly 650 US mid-sized stocks, published as a static site on
GitHub Pages and refreshed every weekday morning by a GitHub Action.

**Live:** https://vandyckmed-droid.github.io/400/

This file is the source of truth for what the product is and how it works. `CLAUDE.md` covers how
to work in this repository and with its owner.

## What the app does

- **List.** Every name in the universe ranked by momentum score, with a 12-month score strip per
  row, a watchlist (star any row), a multi-select sector filter, and a sort menu (blended score,
  12–1 percentile, 6–1 percentile, market cap, ticker A–Z). Rows load in chunks as you scroll.
- **Detail page.** The name's score and placement, its two momentum legs, its standing against the
  whole universe and within its sector, quote and volatility figures, and a bar chart of its score
  at each of the last 36 month ends or 78 week ends with a trailing 4-period average.
- **Price chart.** A full-screen chart of 18 months of adjusted daily bars with a 200-day linear
  regression channel. Drag to pan, pinch to zoom, drag the price axis to stretch it. A button in
  its top bar opens the chart's own small settings panel: today a slider for how strongly the
  channel is shaded (0–40%, default 7%; 0 leaves the lines only). Changes draw live, a touch on
  the chart closes the panel, and the choice persists per device. Any later chart-only setting
  belongs in this panel, not on the settings page.
- **Settings.** Two settings (below), a data card, the methodology, and a description of the
  universe.
- Installable to the iOS home screen as a standalone app. Follows the phone's light or dark mode.
- If the published data is more than four days old the list shows an amber warning.

Everything is computed by Python scripts and served as static JSON. The browser does no math
beyond drawing. The Financial Modeling Prep (FMP) API key never reaches the browser.

## The universe

There is exactly one universe and it is not a setting:

- the S&P MidCap 400 as it stood on the day, plus
- the 250 smallest S&P 500 members by that day's market cap.

The 400/500 boundary is an index-committee decision, not an economic one, so the tail lets a name
be ranked against everything of roughly its size. Membership and market caps are both
point-in-time, so a historical cross-section uses the universe as it stood that day.

**Known limitation.** Names that have since left the index are absent from older cross-sections,
so historical bars carry some survivorship bias. Present-day rankings are unaffected.

## The score

For each name, on each ranking date:

1. **12–1 momentum**: total return on dividend- and split-adjusted closes over the 252 trading days
   ending 21 trading days ago. The last month is skipped to avoid short-term reversal.
2. **6–1 momentum**: the same over 126 trading days, again ending 21 days ago.
3. **Optional adjustment**: each leg is either left as the return, divided by the annualised
   standard deviation of daily log returns over its own window, or replaced by the return net of
   the market.
4. **Percentile**: each leg is ranked 0–100 against the peer set (average ranks for ties).
5. **Blend**: final score = 0.5 × 12–1 percentile + 0.5 × 6–1 percentile.

A name needs at least 180 daily returns in the 12-month window and 90 in the 6-month window, so
recent listings sit out until they season.

**Net of the market** means residual momentum: over each formation window the name's daily log
returns are regressed on the equal-weight average of every priced name, and the leg becomes the
return that regression leaves unexplained. It stops rewarding names that merely rode the market.

### The six peer sets

Two settings change how the one cross-section is read, never which names are in it. Both persist
per device in local storage.

| Setting | Choices |
| --- | --- |
| Score within sector (switch) | Off: rank against the whole universe (`w`). On: rank only against the name's GICS sector (`s`) |
| What each leg measures (three-way) | The return itself (`r`, default); return ÷ its own volatility (`v`); return net of the market (`m`) |

The combination is a two-letter key: `wr`, `wv`, `wm`, `sr`, `sv`, `sm`. All six ship in every
ranking file. Sectors with fewer than five names would be left unscored, but none currently are.

FMP labels S&P 500 sectors with a different taxonomy than the GICS names Wikipedia uses for the
MidCap 400; `scripts/universes.py` maps them onto GICS so names are ranked against their sector,
not their data source.

### Recent joiners

A name that joined the index recently is scored on earlier dates as an "outsider": inserted into
that day's member distribution to find where it would have ranked, without changing the members'
own percentiles. Those bars are dimmed on the charts and labelled "not yet a member".

## How it is built

### Files

```
index.html  styles.css  app.js     the site: vanilla JS, no build step, no dependencies
chart.js                           the price chart: canvas bars, pan / pinch / axis-stretch,
                                   200-day linear regression channel; takes its settings from
                                   app.js as options and exposes set() to change them live
manifest.webmanifest  icon-*.png   home-screen install
.nojekyll                          tells GitHub Pages to serve the files as they are

scripts/build.py                   the whole ranking pipeline, standard library only
scripts/universes.py               universe definition, point-in-time membership, market caps

data/latest.json                   current ranking, all six peer sets, quotes, key stats
data/spark/<key>.json              last 12 month-end scores per name, one file per peer set (6)
data/history/<key>.json            36 month-end scores per name, one file per peer set (6)
data/history/<key>w.json           78 week-end scores per name, loaded only when asked for
data/bars/<SYMBOL>.json            378 adjusted daily bars (~18 months) per ranked name, ~9 MB in all
data/universe.json                 MidCap 400 constituents + change log; also the offline fallback
data/sp500.json                    S&P 500 constituents + change log; also the offline fallback

.github/workflows/refresh.yml      weekday-morning rebuild of data/ + commit
```

### App routes

The app is a single page routed by URL hash: the list at `/`, a ticker at `#/t/SYMBOL`, its price
chart at `#/t/SYMBOL/chart`, and `#/settings`. Files beyond the ranking are fetched lazily and
memoised; a failed optional fetch leaves that piece out rather than breaking the page. Watchlist,
sector filter, both settings, the chart interval and the price chart's own settings persist in
local storage.

Both settings buttons (list top bar and chart top bar) share one hand-drawn sliders icon, kept as
an inline SVG symbol at the top of `index.html`.

### Data sources

All from FMP except the MidCap 400 list, which no FMP plan tier exposes:

| Data | Source |
| --- | --- |
| MidCap 400 members and change log | Scraped from Wikipedia's *List of S&P 400 companies* |
| S&P 500 members and change log | FMP `sp500-constituent` and `historical-sp500-constituent` |
| Market caps (to pick the tail, point-in-time) | FMP `historical-market-capitalization` |
| Prices and bars | FMP `historical-price-eod/dividend-adjusted`, 6 years, ~1,100 symbols |
| Quotes (market cap, 52-week range, last change) | FMP `batch-quote` |

Six years of prices are fetched because the oldest month-end ranking on the history chart looks a
further year back. They are used for the maths and not stored; only the last 378 bars per name are
written to `data/bars/`. Responses are cached under `.cache/` (gitignored) for 12 hours.

### Safeguards

- **Sources down.** Each membership source writes a committed snapshot on success and falls back
  to it on failure, so an outage degrades the refresh to the last good membership.
- **Degraded output.** `build.py` refuses to publish if fewer than 380 of the 400 priced, the
  universe is under 620 names, the ranked count fell more than 5% from last run, or a monthly
  cross-section went missing.
- **Intraday prints.** A bar dated today is dropped when the run happens before 21:00 UTC, so a
  manual daytime run never plots an unsettled close.
- **Reproducibility.** Ties and set iteration are sorted deterministically, so identical inputs
  produce byte-identical files and the job does not commit no-op diffs.

## Automation

`.github/workflows/refresh.yml` runs Tuesday to Saturday at 10:00 UTC, the morning after each
weekday close. It runs `scripts/build.py` and commits `data/` if anything changed. The script exits
non-zero on a degraded result, which stops the job before the commit.

On-demand rebuild: **Actions → Refresh momentum data → Run workflow**.

Publishing is GitHub Pages serving the `main` branch root directly. There is no deploy workflow;
every push to `main`, including the daily data commit, republishes the site.

### One-time setup already done

- Repository secret `FMP_API_KEY` for the workflow.
- Pages configured to deploy from branch `main`, folder `/ (root)`. This cannot be set from CI.

### Running locally

```sh
FMP_API_KEY=your_key python3 scripts/build.py     # rebuild data/ (about 10 minutes, cached after)
python3 -m http.server 8000                        # then open http://localhost:8000
```

## Things that affect future work

- **No dependencies anywhere.** The scripts use only the Python standard library and the site is
  plain HTML, CSS and JS. Adding a package or a build step is a real decision, not a detail.
- **Everything is pre-computed.** A new feature that needs a number the JSON does not carry means a
  change to `build.py` and a refresh, not a browser-side calculation.
- **Repository size grows daily.** The bars folder is rewritten on every run; git stores each
  rewrite as a small delta, but the history is still growing.
- **The universe is fixed by design.** A universe switch was tried and removed because it created a
  "not in this universe" state throughout the app.
- **No backtest lives here.** Whether the score has been worth following was studied in a research
  section that has been removed from the app; it is preserved on the `archive/research` branch.
  Within-sector and sector-relative rankings were never backtested.

## Not investment advice

A percentile is a rank against peers, not a return forecast.
