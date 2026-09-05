# Oscillator prototype

A design study, not a feature. Nothing in this folder is loaded by the site or run by the
refresh job. It asks one question of the universe and six years of its prices: **is there an
oscillator worth having, and if so, which one?**

Files:

| File | What it is |
| --- | --- |
| `oscillator.py` | The study. Standard library only. Reads prices through the same client as the backtest, never writes under `data/`. |
| `REPORT.md` | Every table the script produces, regenerated on each run. |
| `results.json` | The same numbers, machine-readable, plus the weekly series the chart page draws. |
| `index.html` | A phone-sized chart of the recommended oscillator against the universe, reading `results.json`. |

## What was tested

Twenty-nine classic per-stock oscillators (RSI, stochastic, Bollinger z-score, volatility-scaled
rate of change, at lookbacks from 5 to 126 days) and three composites of them, each ranked
across the whole universe at every week end from March 2021 to June 2026 (273 week ends, the
universe rebuilt as it stood on each date, names that later left the index included). Each
reading was set against the return that followed over 1 week, 2 weeks, 1 month and 3 months.
Lookbacks were chosen on the first half of the sample and judged on the second.

The same readings were then aggregated into a **breadth** oscillator for the universe as a
whole: the share of members trading above their own n-day average.

## What the data says

**Per-stock oscillators: nothing worth building.** No family at any lookback predicts a name's
next month. The rank correlations sit between −0.003 and +0.005 with t-statistics under 0.5, and
the sign flips between the two halves of the sample (mild mean reversion in 2021–2023, mild
continuation in 2024–2026). The only consistent pattern is a faint one-to-two-week reversal
from very short lookbacks (RSI 5, 10-day z-score), too small and too fast to matter for a tool
that rebalances monthly. Blending any of them into the momentum score makes the score slightly
worse at one month. Inside the top fifth of the momentum score, "buy the leader on a pullback"
is not supported either: the leaders that had dipped did no better over the next month than the
leaders that had not.

**Breadth: a real signal, in one direction.** The share of members above their 63-day average
is strongly and consistently related to what the whole universe does next.

| | corr with next 1m | corr with next 3m | t (1m) | t (3m) |
| --- | --- | --- | --- | --- |
| 63-day breadth, whole sample | −0.22 | −0.33 | −2.5 | −2.9 |
| first half (2021–Oct 2023) | −0.22 | −0.44 | | |
| second half (Oct 2023–2026) | −0.30 | −0.32 | | |

The relationship is monotone from the 20-day to the 126-day lookback, so it is not a lucky
setting. It lives in the low extreme:

| 63-day breadth reading | weeks | mean next 1 month | mean next 3 months |
| --- | --- | --- | --- |
| washed out (under 25% of names above average) | 30 | +4.3% | +7.9% |
| ordinary (25–75%) | 209 | +0.5% | +1.6% |
| stretched (over 75%) | 34 | −0.5% | 0.0% |

Weeks inside one washout overlap, so the honest count is spells, not weeks. There were ten
washed-out spells. Measured from the first week end of each, the universe was higher three
months later in nine of the ten, by +6.1% on average; the exception was January 2025. The first
week or two after a washout were a coin toss (four of ten up after one week): the reading is
early, and the bounce arrives over months, not days.

The stretched side is much weaker: thirteen spells, roughly flat afterwards on average
(−0.9% at one and three months, five of thirteen up after a month). It is a mild caution, not a
sell signal.

## The recommended design

**Universe breadth oscillator.** Each trading day, the share of universe members whose adjusted
close is above their own 63-day simple moving average, on a 0–100% scale, with two reference
bands:

- **Below 25%: washed out.** Historically the best moment of the cycle to be adding to the
  universe, with the payoff over the following one to three months.
- **Above 75%: stretched.** Expect little from the universe as a whole over the next month; not a
  reason to sell.
- **Between: ordinary.** The oscillator says nothing; the momentum ranking does the work.

Why 63 days: the effect is present from 20 to 126 days and strongest at 63 and 126. The 63-day
version has enough extreme weeks (30 and 34) to say something about both bands, where the
126-day version has visited the low band only 18 weeks in six years. It is also one calendar
quarter, which is easy to explain.

Why bands at 25% and 75%: they are round numbers that split off roughly the outer tenth of
readings on each side. They were fixed before looking at the results and were not tuned.

## Caveats, in order of importance

1. **Six years is a short record for a market-timing claim.** Ten washouts is a small sample and
   they are not independent: five of them fall inside the 2022 bear market. The effect is well
   documented in longer histories of the broad market, which is why this reading of it deserves
   some trust, but it has been tested here on one cycle.
2. **It says nothing about which names to hold**, only whether the tide is coming in. The
   momentum ranking and the breadth oscillator answer different questions.
3. **A washout is by construction a moment when the account is already down.** Acting on it
   means buying while the news is bad. Nine out of ten is not ten out of ten.
4. **No costs, no taxes**, as with everything on the evidence page.

## What building it would involve

If this ever moves from prototype to product: one extra number per day in the build pipeline
(the share above the 63-day average is a few lines in `build.py`, computed from prices already
in memory), a small history series to draw, and a single panel on the evidence or settings page
with the reading, the two bands and the last few years. No new data source, no dependency, and
no change to the ranking itself. A per-stock oscillator on the detail chart is not recommended,
because the data above says it would be decoration.

## Running it

```sh
# Six-year, point-in-time run (the real test). Same key the refresh job uses.
FMP_API_KEY=your_key python3 prototypes/oscillator/oscillator.py

# Without a key: a three-year preview from the committed bars, today's members only.
python3 prototypes/oscillator/oscillator.py
```

About three minutes once prices are cached. It rewrites `REPORT.md` and `results.json` in this
folder and nothing else.
