# S&P 900 Momentum

A phone-first momentum ranking of the S&P 500 and S&P MidCap 400 together, roughly 900 US stocks,
published as a static site on GitHub Pages and refreshed every weekday morning by a GitHub Action.

**Live:** https://vandyckmed-droid.github.io/400/

This file is the source of truth for what the product is and how it works. `CLAUDE.md` covers how
to work in this repository and with its owner.

## What the app does

- **List.** Every name in the universe ranked by the score. Each row: the rank, the ticker with
  its sector beneath, and on the right the score in the chosen display (value, rank or
  percentile) over the name's annualised volatility of the last 63 trading days. A watchlist
  (star any row), a multi-select sector filter, and a sort menu: score (strongest first, under
  the active Score settings), market cap, or ticker A–Z. Rows load in chunks as you scroll.
- **Previous / next.** Under the top bar of the detail page and of the chart, a strip steps to the
  name either side of this one in the list as it stands (its sort, sector filter and watchlist
  state), showing the position ("12 of 646"). Stepping between charts keeps the zoom. Left and
  right arrow keys do the same on a keyboard. Steps replace the current history entry, so Back
  still returns to where the reader came from.
- **Detail page.** One focus card: the score in the chosen display, coloured by percentile, with
  the other two readings and the settings that built it beside it, a muted line of sector,
  industry and market cap, and a 12-month strip of month-end standings with the 63-day
  volatility. For the names that have it (the regional banks, so far), a **9–1 momentum
  decomposition**: three bars on one zero line, the raw 9–1 return, the return net of the
  market, and the return net of the market and the name's industry group, with the two gaps
  named; the middle bar is the same number as the "Net of market" row in Score components (the
  score's rolling beta), the third comes from an in-window two-factor regression. Below, a link row to the price chart and three sections that expand in
  place, each with its one key fact in the row: **Score components** (the window's ingredients —
  return, net-of-market return, volatility, residual volatility — with the ones in use marked and
  the score written out), **Against its peers** (the name's
  percentile and rank across the universe and within its own GICS sector, by the same score), and
  **Quote & risk** (price and change). The score through time lives under the price chart.
- **Price chart.** A full-screen chart of three years of adjusted daily bars. Drag to pan, pinch to
  zoom, drag the price axis to stretch it. A button in its top bar opens a full-screen list of what
  the chart draws. First the **price plot** itself, whose settings are the price axis: linear
  (default) or log, where equal percentage moves are equal heights; switching returns the range to
  automatic. Then, under an "On the chart" divider, the overlays, each with an eye that shows or
  hides it and its own settings a tap away: the **regression channel** (on by default), a
  least-squares line through the closes with bands either side (through their logarithm when the
  axis is log, so the channel is straight on either axis), with settings for length (20–360 days,
  default 200), width (1–3 standard deviations, default 2) and fill (0–40%, default 7%; 0 leaves
  the lines only); and two **moving averages** (both off by default), simple averages of the
  closes, the first drawn in amber (period 5–200 days, default 50), the second in violet (period
  5–300 days, default 200), so the common 50/200 pair is two eyes away. A second divider, "Below
  the chart", holds what is drawn in its own pane beneath the price, on the same dates: the
  **score** (on by default), the name's daily score under the active Settings, in the chosen
  display, as a line or as bars (a setting), with the latest value tagged on its axis. The pane's
  scale follows the display: a percentile runs 0–100, a rank runs from 1 at the top to the member
  count at the bottom, a value spans the series with zero as the baseline and negative values
  below it. The pane pans with the bars; its height is a setting (12–60% of the chart, default
  24%) that the divider between the panes also drags. Tapping the pane's label on the chart opens
  its settings. An item's settings open as a small sheet over the chart, so changes draw live and
  a touch on the chart closes it. A Reset in the list's top row, confirmed by a second tap,
  returns everything to defaults, and every choice persists per device. A new overlay or pane is a
  new entry in chart.js plus its drawing; the list builds itself from that.
  **Press and hold** on either pane for a crosshair: a vertical through both panes that slides
  from bar to bar under the finger, a horizontal at the finger, the date on the time axis, the
  price (or score) under the finger on the axis, and a readout of the bar's open, high, low,
  close, day change and score. It stays when the finger lifts; the next touch clears it.
- **Settings.** The Score section (four choices, below; a ⓘ by *Market residualization* reveals
  the residual formula), a data card, the methodology as the
  settings define it, and a description of the universe.
- Installable to the iOS home screen as a standalone app. Follows the phone's light or dark mode.
- If the published data is more than four days old the list shows an amber warning.

The pipeline (Python) computes every day's cross-section and serves static JSON; the browser
builds the score for the list from the day's published ingredients with the same arithmetic. The
Financial Modeling Prep (FMP) API key never reaches the browser.

## The universe

There is exactly one universe and it is not a setting:

- the S&P 500 as it stood on the day, plus
- the S&P MidCap 400 as it stood on the day.

Together they are the S&P 900. The 400/500 boundary is an index-committee decision, not a fact
about a company, so every name is ranked against all the others whichever index holds it.
Membership is point-in-time, so a historical cross-section uses both indices as they stood that
day.

### Cleanliness

Three rules keep a member out of a day's cross-section, on every date:

- **Seasoning.** At least 504 bars (about two years) of trading history by that date, so the
  window never starts inside a new listing's or spin-off's first months of price
  discovery. Without it a name like Sandisk, spun off in early 2025, scored +13.8 standard
  deviations and stretched the whole scale.
- **Flat names.** A window annualised volatility of at least 8%. Below that a stock is
  trading on a pending takeover, not on its own merits.
- **One line per company.** Where two share classes of one company are both members, only the
  Class A share is kept (GOOGL, FOXA, NWSA; not GOOG, FOX, NWS). With no class named A, the first
  symbol alphabetically stays.

`latest.json`'s `meta.excluded` lists the share classes left out and today's members that did not
clear the first two bars; the Settings data card shows them.

**Known limitation.** Names that have since left the index are absent from older cross-sections,
so historical bars carry some survivorship bias. Present-day rankings are unaffected.

### Momentum decomposition

For one industry group so far, the regional banks (GICS sub-industry *Regional Banks*,
`DECOMP_GROUP` in `build.py`), each row carries `decomp`: the raw 9–1 return; the return net of the market (the
leg's own residual, so the same rolling beta); and the return net of the market and the group, where the group is the
equal-weight average of the other members with its market component removed in-window before a
two-factor in-window regression. `meta.decomp` names the group and its symbols. Every name now
carries a GICS sub-industry from one list, so the same figure can be extended to other groups.

## The score

One definition, with three choices made in Settings. The pipeline publishes the ingredients for
every combination; the browser builds the score the reader has chosen, step for step as the
pipeline does for the daily series, on the same rounded numbers, so every view agrees.

For each name, on each trading day:

1. **One window, 9–1.** Total return on dividend- and split-adjusted closes over the 189 trading
   days ending 21 trading days ago; the last month is skipped to avoid short-term reversal.
2. **Adjustments**, each a switch:
   - *Market residualization*: the window's return (as a log return) minus beta times the
     market's over the same window. The market is the equal-weight average of the names that were
     index members on each day, rebalanced daily; beta is the slope of the name's daily log
     returns on the market's over the 756 trading days (about three years) ending on the day, or
     as much of that as the name has traded, 252 days at least.
   - *Volatility adjustment*: the (possibly residual) return is divided by the annualised standard
     deviation of the (possibly residual) daily log returns over the same window.
3. **That measure is the score.** There is no standardization step, so the score
   is a return, or a return per unit of risk when the volatility switch is on. Nothing about the
   rest of the universe enters it.
4. **Display**, a reading of the same number that never changes the order:
   - *Score value*: the number itself, signed; a percentage, or a plain ratio when the volatility
     switch is on.
   - *Rank*: integer position across the whole scored universe, 1 = best; ties share the better
     position.
   - *Percentile*: 100 × (n − rank) ÷ (n − 1) across the whole scored universe, 100 = best.

A name needs at least 135 daily returns in the window, so recent listings sit out until they
season.

### The 4 definitions

The four adjustment combinations give four score definitions, keyed by the adjustment alone:
`none`, `vol`, `resid` or `volresid`. Every one is published, so a change of settings is a
different file, not a rebuild. Display needs nothing extra: rank and percentile are read off the
day's ladder of member scores, the members' scores as ascending fixed-point integers (the score
× 1,000,000, the same integer in Python and in the browser so a rank never turns on a rounding
difference).

Defaults: no adjustments, percentile. Both persist per device.

A detail page's *Against its peers* section also ranks the name within its own GICS sector, by the
same score, among the sector's scored members: a position, not a different score.

Every name's sector and sub-industry are GICS labels read from Wikipedia's index list pages, the
S&P 500 page for its members and the MidCap 400 page for the rest, so the sector filter, the
sector rank and the industry groups follow one taxonomy, not the data source. FMP's own sector taxonomy (Yahoo/Morningstar names,
which disagree with GICS on about thirty S&P 500 names) is only the last resort for a name the
Wikipedia page does not carry; `scripts/universes.py` maps its sector names onto GICS.

### Recent joiners

A name that joined the index recently is scored on earlier dates as an outsider: ranked on that
day's members' ladder to find where it would have stood, without entering it. Present-day
rankings are unaffected.

## How it is built

### Files

```
index.html  styles.css  app.js     the site: vanilla JS, no build step, no dependencies
chart.js                           the price chart: canvas bars, pan / pinch / axis-stretch, and
                                   the indicators (regression channel, moving average) with their
                                   defaults and ranges; app.js hands in the saved settings and
                                   changes them live through set()
manifest.webmanifest  icon-*.png   home-screen install
.nojekyll                          tells GitHub Pages to serve the files as they are

scripts/build.py                   the whole ranking pipeline, standard library only
scripts/universes.py               universe definition, point-in-time membership, market caps

data/latest.json                   today's rows (legs, 63-day volatility, quote, key stats):
                                   everything the browser needs to score the list
data/score/<key>.json              one per score definition (4): for each of the last 756 trading
                                   days, the member count and the ladder of member scores
                                   (base64 int32); fetched only when the chart opens
data/spark/<key>.json              last 12 month-end scores and ranks per name, one per definition
data/bars/<SYMBOL>.json            756 adjusted daily bars (~3 years) per ranked name, with the
                                   name's 9-1 legs (return, volatility, net-of-market return,
                                   residual volatility) on the same dates
data/universe.json                 MidCap 400 constituents + change log; also the offline fallback
data/sp500.json                    S&P 500 constituents + change log; also the offline fallback

.github/workflows/refresh.yml      weekday-morning rebuild of data/ + commit
```

### App routes

The app is a single page routed by URL hash: the list at `/`, a ticker at `#/t/SYMBOL`, its price
chart at `#/t/SYMBOL/chart`, and `#/settings`. Files beyond the ranking are fetched lazily and
memoised; a failed optional fetch leaves that piece out rather than breaking the page. Watchlist,
sector filter, both settings, the chart interval and the chart's indicator settings persist in
local storage (the last under one key, `sp400.chart.v1`, one object per indicator plus one for the
axis).

Both settings buttons (list top bar and chart top bar) share one hand-drawn sliders icon, kept as
an inline SVG symbol at the top of `index.html`.

### Data sources

All from FMP except the MidCap 400 list, which no FMP plan tier exposes:

| Data | Source |
| --- | --- |
| MidCap 400 members | Scraped from Wikipedia's *List of S&P 400 companies*; a logged change the table has not caught up with is applied to it |
| MidCap 400 change log | Scraped from Wikipedia's *Historical components of the S&P 400* (the list page is read as a fallback); an empty log counts as the source being down |
| S&P 500 members and change log | FMP `sp500-constituent` and `historical-sp500-constituent` |
| S&P 500 sector and sub-industry | Scraped from Wikipedia's *List of S&P 500 companies* (GICS, the same taxonomy as the MidCap 400 page); with Wikipedia down, the last run's labels stand in |
| Prices and bars | FMP `historical-price-eod/dividend-adjusted`, 6 years, ~1,000 symbols |
| Quotes (market cap, 52-week range, last change) | FMP `batch-quote` |

Six years of prices are fetched because the oldest daily score looks a further year back. They
are used for the maths and not stored; only the last 756 bars per name are written to
`data/bars/`, each with the legs alongside. The 756 daily cross-sections take under a minute.
Responses are cached under `.cache/` (gitignored) for 12 hours.

### Safeguards

- **Sources down.** Each membership source writes a committed snapshot on success and falls back
  to it on failure, so an outage degrades the refresh to the last good membership.
- **Degraded output.** `build.py` refuses to publish if fewer than 380 of the 400 priced, the
  universe is under 850 names, the ranked count fell more than 5% from last run, or more than five
  of the 756 daily cross-sections could not be scored.
- **Intraday prints.** A bar dated today is dropped when the run happens before 21:00 UTC, so a
  manual daytime run never plots an unsettled close.
- **Reproducibility.** Ties and set iteration are sorted deterministically, so identical inputs
  produce byte-identical files and the job does not commit no-op diffs.

## Automation

Two branches:

- **`main`** holds the code. `data/` is git-ignored there and never committed.
- **`site`** holds what GitHub Pages serves: the code plus `data/`, as a single commit that the
  refresh job rewrites (force-pushes) on every run. No history of the data is kept, so the
  repository stays the size of one day's site instead of growing by every day's rewrite. A
  `site.txt` at its root carries the time it was published.

`.github/workflows/refresh.yml` runs Tuesday to Saturday at 10:00 UTC, the morning after each
weekday close. It checks out `main`, restores `data/` from `site` (the membership snapshots
`build.py` falls back to and the previous `latest.json` its guards compare against), runs
`scripts/build.py`, then publishes `site`. The script exits non-zero on a degraded result, which
stops the job before the publish. A push to `main` runs the same job without the rebuild, so a
code change is live within a minute with the previous day's data.

On-demand rebuild: **Actions → Refresh momentum data → Run workflow**.

### One-time setup already done

- Repository secret `FMP_API_KEY` for the workflow.
- Pages configured to deploy from branch `site`, folder `/ (root)`. This cannot be set from CI.

### Running locally

```sh
git fetch origin site && git restore --source=origin/site -- data   # today's data, from the site branch
python3 -m http.server 8000                                          # then open http://localhost:8000
FMP_API_KEY=your_key python3 scripts/build.py                        # or rebuild data/ (a few minutes)
```

## Things that affect future work

- **No dependencies anywhere.** The scripts use only the Python standard library and the site is
  plain HTML, CSS and JS. Adding a package or a build step is a real decision, not a detail.
- **One score, built in two places.** `build.py` (`measure`, `cross_section`) and `app.js` (the
  score module at the top) build the score with the same steps on the same rounded inputs; that is
  what lets the list score itself in the browser while the daily series is published. A change to
  the definition is a change to both, kept step for step identical, plus a refresh. Anything else a
  view needs that the JSON does not carry is a change to `build.py` and a refresh.
- **Repository size grows daily.** The bars folder is rewritten on every run; git stores each
  rewrite as a small delta, but the history is still growing.
- **The universe is fixed by design.** A universe switch was tried and removed because it created a
  "not in this universe" state throughout the app.
- **No backtest lives here.** Whether the score has been worth following was studied in a research
  section that has been removed from the app; it is preserved on the `archive/research` branch.
  Within-sector and sector-relative rankings were never backtested.

## Not investment advice

The score is a standing against peers, not a return forecast.
