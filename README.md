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
| Cross-sectional percentile | Each leg is ranked against every other name in the chosen **peer set** on that date and mapped to 0–100 (average ranks, so ties share a percentile). |
| Blend | **Final score = 0.5 × 12–1 percentile + 0.5 × 6–1 percentile.** |

A name needs a full 12-month window (≥ 180 daily returns) and a full 6-month window (≥ 90) to be
ranked, so very recent index additions sit out until they season.

The **history chart** re-runs the entire cross-section at each snapshot, so a bar shows where a name
stood *against its peers on that date* — not a rescaling of today's numbers. A trailing 4-period
average (4 weeks or 4 months, following the interval) is drawn over the bars: enough to smooth the
week-to-week noise without lagging so far that a turn only shows after it's over.

**Recent joiners.** Membership is point-in-time, so a name that joined the index in April has only
five month-ends as a member — and a five-bar chart for a five-year-old stock tells you nothing.
On dates before it joined, the name is scored *as an outsider* against that day's members: inserted
into their distribution to find where it would have ranked, without disturbing the members' own
percentiles (which are byte-identical with or without it). Those bars are dimmed, the readout says
"not yet a member", and the note gives the join date. At the time of writing 103 names in the 400
and 178 in the 650 have at least one such bar. The backtest never uses these — it ranks members
only. Two intervals are
published and switchable on the chart: 36 month ends for the long shape, and 78 week ends (~18
months) when the monthly bars are too coarse to see a turn. The weekly files are roughly three times
the size, so they load only when that view is opened. The weekly axis keeps the in-progress week —
a bar is a cross-section taken on a date, not a return over a period, so a partial week still reads
correctly and the last bar stays close to today.

### Known limitation

The peer set is today's index membership at every historical date. Names that have since left the
index are absent from older cross-sections, so historical bars carry some survivorship bias. Fixing
this properly needs point-in-time constituent snapshots, which the current data plan doesn't expose.
Present-day rankings are unaffected.

## Universe, and how it's scored

The score is a percentile, so it only means anything relative to a peer group. That group is set by
two **independent** controls, deliberately not merged into one:

- **Universe** — `MidCap 400` or `MidCap 650`. A mode, and it *is* the title: tapping the number
  switches it, and every ranking and chart then runs on it. It has no control of its own, because
  naming the app after the universe already says which one is active and switching it is the same
  tap. Not re-offered anywhere else.
- **Score within sector** — a switch, not a universe. It ranks a name only against its own GICS
  sector inside whichever universe is active.

Both persist per device, and the four resulting combinations all ship in `latest.json` keyed
`c`/`e` + `w`/`s`. Merging them into a single four-option control was the original design and it was
wrong: it forced you to re-pick the universe every time you wanted to change how it was scored, and
made the per-ticker card display both universes at once.

**Why the extended universe.** The 400/500 boundary is an index-construction artefact, not an
economic one: a $50B S&P 500 laggard and a $36B MidCap 400 leader are competing for the same
capital. The name is loose — those 250 are large-cap by index membership and mid-cap by size — so
they are badged in the list and the methodology dialog says exactly what they are. Adding the S&P 500's small tail measures a name against everything of roughly its size.
Membership and the market caps that pick the tail are both point-in-time, so a bar from 2024 uses
the universe as it stood in 2024, not today's.

**Why within-sector.** The whole-universe ranking takes large implicit sector positions — at the
time of writing, zero of the top 40 are Utilities, Staples or Communication Services, and nearly
half of Consumer Staples sits in the worst decile. Ranking inside the sector strips that bet out,
which is what you want if sector weights are already controlled elsewhere. Sectors thinner than
five names are left unscored: a percentile across four names says nothing.

A per-ticker card shows both bases for the active universe side by side, which is where the sector
basis earns its keep — a name can be 6th of 649 against the whole universe and 1st of 51 inside its
sector.

One taxonomy note: FMP labels S&P 500 sectors with the Yahoo/Morningstar scheme
("Technology", "Healthcare") while Wikipedia's MidCap 400 table uses GICS
("Information Technology", "Health Care"). `universes.py` maps the former onto the latter — without
it the extended universe would rank each name against others from its own *data source* rather than
its own sector.

## Layout

```
index.html  styles.css  app.js   the site (vanilla JS, no build step, no dependencies)
data/latest.json                 current ranking, all four peer sets + key stats  (~300 KB)
data/history/{cw,cs,ew,es}.json  score per month end (36), one file per peer set, lazy-loaded
data/history/{...}w.json         score per week end (78 ~ 18 months), loaded only if asked for
data/universe.json               MidCap 400 constituents + change log; the offline fallback
data/sp500.json                  S&P 500 constituents + change log; the offline fallback
manifest.webmanifest  icon-*.png   home-screen install
scripts/build.py                 the whole pipeline, standard library only
scripts/universes.py             universe definitions + point-in-time membership
scripts/backtest.py              point-in-time membership + forward-return test
data/backtest.json               decile returns, spreads and the spread time series
.github/workflows/refresh.yml    weekly rebuild + commit
```

The API key never reaches the browser: everything is computed server-side in the refresh job and
served as static JSON.

## Data

- **S&P 500 membership** — FMP `stable/sp500-constituent` and `stable/historical-sp500-constituent`
  (Wikipedia no longer carries a changes table for the 500).
- **Market caps** — FMP `stable/historical-market-capitalization`, used to pick the small tail on
  the day rather than approximating it from today's share counts.
- **Universe** — scraped from Wikipedia's *List of S&P 400 companies* (there is no MidCap 400
  constituent endpoint on this FMP plan). Each successful scrape rewrites `data/universe.json`,
  which doubles as the fallback if the scrape ever fails.
- **Prices** — FMP `stable/historical-price-eod/dividend-adjusted`, 6 years per ticker,
  ~1,100 symbols (both indices plus former members still inside the history window).
- **Quotes** — FMP `stable/batch-quote` for market cap, 52-week range and last change.

## What the app does when things go wrong

- **Stale data.** The refresh is weekly and silent, so a failed job would leave an old ranking
  looking fresh. If the published data is more than ten days old the list shows an amber banner
  saying so.
- **Sources down.** Each membership source (Wikipedia for the 400, FMP for the 500 and its change
  log) persists to a committed snapshot on success and falls back to it on failure, so an outage
  degrades the refresh to last week's membership rather than failing it.
- **Degraded output.** `build.py` refuses to publish if fewer than 380 of the 400 priced, the
  extended universe is under 620 names, the ranked count fell more than 5% from the last run, or
  a monthly cross-section went missing — the vendor throttles in alphabetical blocks, and a partial
  outage would otherwise commit a quietly wrong ranking.
- **Home screen.** Ships a manifest and icons; "Add to Home Screen" on iOS gives a standalone app
  with safe-area padding.

## Refreshing

Automatic: `.github/workflows/refresh.yml` runs Saturdays at 12:00 UTC, rebuilds the ranking and
the backtest, and commits `data/` if anything changed. Momentum on 12- and 6-month windows barely moves intraday, so weekly is the right
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

**Scope: the MidCap 400 ranked as a whole.** The extended universe and the within-sector bases are
display options, not tested — a sector-relative ranking is a different signal and would need its
own test. `scripts/backtest.py` answers the question honestly for the peer set it does cover. It rebuilds month-by-month index membership by
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
