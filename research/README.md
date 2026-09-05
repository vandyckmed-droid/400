# Research

The part of this project that asks whether the ranking works and what else the universe has to
say. It is a reference, not a feature: published by the same GitHub Pages site at
https://vandyckmed-droid.github.io/400/research/, but outside the app.

## How it is separated from the app

- The app loads nothing from this folder. It carries one link here, at the foot of the
  methodology text in Settings, and the old in-app `#/evidence` route redirects here.
- Pages here have their own stylesheet (`research.css`) and their own copy of any chart code they
  need (`evidence.js`). Nothing is shared with `app.js` or `styles.css`, so a change on either side
  cannot break the other. The tokens in `research.css` are copied from `styles.css`; if the app's
  palette changes, copy them again by hand.
- The scripts here import the momentum maths from `scripts/build.py`, so the tests and the live
  ranking cannot diverge, but they write only under `research/`. They never touch `data/`, and the
  shared membership loaders are wrapped so a research run never rewrites the app's snapshots.
- The daily refresh (`.github/workflows/refresh.yml`) never runs anything here.

## What is here

| Page | What it shows | Data |
| --- | --- | --- |
| `index.html` | The front page: every study with the dates its numbers cover | reads the files below |
| `evidence.html` | Top 10% vs all ranked: the point-in-time portfolio record, how each line is built, results, sector concentration, forward returns by decile, caveats. A control on the page picks which leg measure the ranking used. | `data/backtest.json`, `data/portfolio.json` |
| `oscillator/near-lows-chart.html` | The share of names near their yearly lows under the equal-weight universe, as one interactive chart | `oscillator/results-derived.json` |
| `oscillator/near-lows.html` | The same reading with its bands, each spell and what followed, and the statistics | `oscillator/results-derived.json` |
| `oscillator/index.html` | 63-day breadth: share of names above their 63-day average, bands, washouts | `oscillator/results.json` |

Scripts:

| Script | Writes | Notes |
| --- | --- | --- |
| `scripts/backtest.py` | `data/backtest.json` | At each of up to 60 month ends, rebuild point-in-time membership, rank, split into deciles, measure 1-, 3- and 6-month forward returns. Decile means, top-minus-bottom spread, hit rate, t-statistics with the overlap correction. |
| `scripts/portfolio.py` | `data/portfolio.json` | Buy the top decile equally weighted at each month end, hold until the next, for up to 60 months. Daily NAV for top decile, bottom decile and the equal-weight universe; return, volatility, drawdown, sector concentration at each rebalance. No costs or taxes. |
| `oscillator/oscillator.py` | `oscillator/results.json`, `REPORT.md` | Textbook oscillators tested per stock (none work) and the breadth reading |
| `oscillator/derived.py` | `oscillator/results-derived.json`, `DERIVED.md` | A reading derived from the data with no formula assumed; the near-lows share |
| `ma-cross/ma_cross.py` | `ma-cross/results.json`, `REPORT.md` | 254 moving-average crossover pairs scored on how well they time each name's peaks and valleys; none beats holding, EMA 40/60 marks turns most reliably |

`oscillator/README.md` is the design note for the two oscillator studies: what was tested, the
verdicts, the recommended designs and the caveats.
`ma-cross/README.md` is the design note for the moving-average cross study: what was tested, the
trade-off between lag and false alarms, the recommended durations and the caveats. It has no page;
the report is the deliverable.

## Refreshing it

The numbers here are a snapshot of the day they were last run. To bring them up to date:
**Actions → Refresh research → Run workflow**. That reruns all five scripts against the vendor's
six-year price history (about fifteen minutes) and commits `research/` if anything changed. Nothing
else runs it.

Locally, with the vendor key:

```sh
FMP_API_KEY=your_key python3 research/scripts/backtest.py
FMP_API_KEY=your_key python3 research/scripts/portfolio.py
FMP_API_KEY=your_key python3 research/oscillator/oscillator.py
FMP_API_KEY=your_key python3 research/oscillator/derived.py
FMP_API_KEY=your_key python3 research/ma-cross/ma_cross.py
python3 -m http.server 8000        # then open http://localhost:8000/research/
```

## Not investment advice

Every figure here is a backtest with no costs or taxes, over one market cycle. A percentile is a
rank against peers, not a return forecast.
