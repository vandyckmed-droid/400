# S&P 900 Momentum

A phone-first momentum ranking of the S&P 500 and S&P MidCap 400 together, roughly 900 US stocks,
published as a static site on GitHub Pages and refreshed every weekday morning by a GitHub Action.

**Live:** https://vandyckmed-droid.github.io/400/

This file is the source of truth for what the product is and how it works. `CLAUDE.md` covers how
to work in this repository and with its owner.

## What the app does

- **List.** Every name in the universe ranked by the score, shown in the chosen display (value,
  rank or percentile), with a 12-month strip of month-end standings per row, a watchlist (star any
  row), a multi-select sector filter, and a sort menu: score (strongest first, under the active
  Score settings), market cap, or ticker A–Z. Rows load in chunks as you scroll.
- **Previous / next.** Under the top bar of the detail page and of the chart, a strip steps to the
  name either side of this one in the list as it stands (its sort, sector filter and watchlist
  state), showing the position ("12 of 646"). Stepping between charts keeps the zoom. Left and
  right arrow keys do the same on a keyboard. Steps replace the current history entry, so Back
  still returns to where the reader came from.
- **Detail page.** One focus card: the score in the chosen display, coloured by percentile, with
  the other two readings and the settings that built it beside it, and a muted line of sector,
  industry and market cap. Below, a link row to the price chart and three sections that expand in
  place, each with its one key fact in the row: **Score components** (the two periods side by
  side: return, net-of-market return, volatility, the measure the settings pick, the peer mean
  and standard deviation, the z-score, and the blend written out), **Against its peers** (the same
  name standardized against the universe and against its sector, with the rank each gives), and
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
- **Settings.** The Score section (four choices, below), a data card, the methodology as the
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

**Known limitation.** Names that have since left the index are absent from older cross-sections,
so historical bars carry some survivorship bias. Present-day rankings are unaffected.

## The score

One definition, with four choices made in Settings. The pipeline publishes the ingredients for
every combination; the browser builds the score the reader has chosen, step for step as the
pipeline does for the daily series, on the same rounded numbers, so every view agrees.

For each name, on each trading day:

1. **Two periods.** *12–1*: total return on dividend- and split-adjusted closes over the 252
   trading days ending 21 trading days ago; the last month is skipped to avoid short-term
   reversal. *6–1*: the same over 126 trading days, again ending 21 days ago.
2. **Adjustments**, each a switch, applied to each period:
   - *Market residualization*: over the window the name's daily log returns are regressed on the
     equal-weight average of every priced name, and the period's return becomes what the
     regression leaves unexplained (the intercept times the number of days: the return net of
     beta times the market's).
   - *Volatility adjustment*: the (possibly residual) return is divided by the annualised standard
     deviation of the (possibly residual) daily log returns over the same window.
3. **Standardize** the period's measure against its peers on that day: (measure − peer mean) ÷
   peer standard deviation (population), rounded to two decimals. Peers are *Universe* (every
   scored member) or *Sector* (the members of the name's GICS sector; a sector under five names
   is left unscored).
4. **Period choice**: the score is the 12–1 z-score, the 6–1 z-score, or *Blend*: the two
   z-scores averaged 50/50, again to two decimals.
5. **Display**, a reading of the completed score that never changes the order:
   - *Score value*: the number itself, signed; 0 is the peer average.
   - *Rank*: integer position across the whole scored universe, 1 = best, whatever the score was
     standardized against; ties share the better position.
   - *Percentile*: 100 × (n − rank) ÷ (n − 1) across the whole scored universe, 100 = best.

A name needs at least 180 daily returns in the 12-month window and 90 in the 6-month window, so
recent listings sit out until they season.

### The 24 definitions

Period (3) × adjustments (4 combinations) × basis (2) gives 24 score definitions, keyed
`<period>-<adjust>-<basis>`: period `12`, `6` or `blend`; adjust `none`, `vol`, `resid` or
`volresid`; basis `universe` or `sector`. Every one is published, so a change of settings is a
different file, not a rebuild. Display needs nothing extra: rank and percentile are read off the
day's ladder of member scores.

Defaults: blend, no adjustments, universe, percentile. All four persist per device.

FMP labels S&P 500 sectors with a different taxonomy than the GICS names Wikipedia uses for the
MidCap 400; `scripts/universes.py` maps them onto GICS so names are standardized against their
sector, not their data source.

### Recent joiners

A name that joined the index recently is scored on earlier dates as an outsider: standardized
against that day's members and ranked on their ladder to find where it would have stood, without
entering the members' statistics. Present-day rankings are unaffected.

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

data/latest.json                   today's rows (legs, quote, key stats) and the day's peer
                                   statistics: everything the browser needs to score the list
data/score/<key>.json              one per score definition (24): for each of the last 756
                                   trading days, the member count, the peer statistics it
                                   standardizes against, and the ladder of member scores
                                   (base64 int16); ~1.3 MB each, fetched only when the chart opens
data/spark/<key>.json              last 12 month-end scores and ranks per name, one per definition
data/bars/<SYMBOL>.json            756 adjusted daily bars (~3 years) per ranked name, with the
                                   name's two legs (return, volatility, net-of-market return,
                                   residual volatility) on the same dates; ~55 MB in all
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
