# Oscillator prototype

A design study, not a feature. This folder is part of the research section (`research/`),
outside the app: nothing in it is loaded by the app or run by the daily refresh, and the
"Refresh research" workflow reruns it on demand. It asks one question of the universe and six years of its prices: **is there an
oscillator worth having, and if so, which one?**

Files:

| File | What it is |
| --- | --- |
| `oscillator.py` | The study. Standard library only. Reads prices through the same client as the backtest, never writes under `data/`. |
| `REPORT.md` | Every table the script produces, regenerated on each run. |
| `results.json` | The same numbers, machine-readable, plus the weekly series the chart page draws. |
| `index.html` | A phone-sized chart of the recommended oscillator against the universe, reading `results.json`. |
| `derived.py` | The second study: an oscillator derived from the data itself, no textbook formula assumed. |
| `DERIVED.md` | Every table the second study produces, regenerated on each run. |
| `results-derived.json` | The same numbers, machine-readable, plus the weekly universe series. |
| `near-lows.html` | A phone-sized chart of the near-yearly-lows share against the universe, reading `results-derived.json`. |
| `near-lows-chart.html` | The same two series as one interactive chart: shared crosshair, drag to pan, pinch to zoom time, drag either value axis to stretch it. |

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

## Second study: derived from the data, not borrowed

The first study only asked whether the textbook oscillators work. The second (`derived.py`) assumes
no formula at all. For every name at every week end it takes sixteen plain descriptors of its own
recent behaviour, each in the name's own units: its return over 5, 10, 21, 42, 63, 126 and 252
days divided by its own volatility ("how many sigmas has it moved"), where it sits in its 63-day
and 252-day range, its drawdown from the yearly high, whether its volatility is rising, its biggest
up and down day of the month, where its closes sat inside each day's range, and two volume
readings. Then, week by week, it lets the data say which of those predicted the next month
(one cross-sectional regression per week, coefficients averaged, on the first half of the sample
only), and builds the reading as the weighted sum of a name's descriptor ranks, expressed as a
0–100 percentile against the universe that day. Weights are also refitted walk-forward every
quarter using only weeks whose outcome was already known.

**At the stock level, the data rediscovers momentum and nothing else.** Of sixteen descriptors,
training kept two: the one-year sigma-scaled return and a short-term volume surge. The full
sixteen-descriptor model fitted noise (rank correlation +0.042 in training, −0.005 out of
sample). The sparse model held up out of sample (+0.041, t 2.1) and walk-forward (+0.027 a month,
+0.043 a quarter), but that is the same signal the site already ranks on, in a different coat, and
its top-minus-bottom decile spread walk-forward (+0.9% a month, +2.1% a quarter) is no better than
the momentum score's (+1.0%, +3.0%). Every short-horizon descriptor, the ones an oscillator in the
"stretched, due to snap back" sense would be built from, had a mean-reversion sign in the first
half and the opposite sign in the second. There is no per-stock oscillator to be derived from this
data, textbook or otherwise.

**At the universe level, the data produced a clean new reading.** Aggregating the same descriptors
across members and testing each against the universe's own forward return, with bands set from the
training half's own distribution rather than by hand, the strongest and most stable is the
**share of members sitting in the bottom tenth of their own 52-week range** (the "near yearly
lows" share):

| near-lows share | weeks | mean next 1 month | mean next 3 months |
| --- | --- | --- | --- |
| under 2% (almost nobody at a low) | 12 | −2.3% | −3.4% |
| 2% to 24% | 220 | +0.7% | +2.0% |
| over 24% (a quarter of the universe at lows) | 14 | +4.7% | +8.5% |

Rank correlation with the next quarter +0.32 (t 3.4), and the same figure in both halves of the
sample (+0.34 and +0.32). Unlike the 63-day breadth reading, which only speaks at the washed-out
end, this one carries information in both tails: a universe where almost nothing is at a yearly
low has gone on to disappoint. The reading today is 12%, ordinary.

A combined reading (near-lows share, the median name's one-month stretch, and the share of names
that fell more than two sigmas in a month, each as a percentile of the training distribution and
averaged) reads above 80% in twelve spells, ten of which were followed by a higher universe a month
later (+3.0% on average) and nine a quarter later (+5.1%); below 20% in seven spells, five of which
were followed by a lower universe a month later (−2.5%). The single near-lows share is simpler and
nearly as good, so it is the design to prefer.

**Recommended design, second study.** Each trading day, the share of universe members whose close
sits in the bottom tenth of their own 252-day high-low range, on a 0–100% scale, with bands at
about 2% (complacent: expect less) and about 25% (capitulated: expect more), both taken from the
data. It complements the momentum ranking rather than competing with it: the ranking says which
names, this says whether the tide is going out or coming in. Both readings, this and the 63-day
breadth, come from the prices already in the build, so either would cost one number a day.

## Caveats, in order of importance

1. **Six years is a short record for a market-timing claim.** Ten washouts is a small sample and
   they are not independent: five of them fall inside the 2022 bear market. The near-lows reading
   has 14 weeks in its upper band and 12 in its lower. The effect is well documented in longer
   histories of the broad market, which is why these readings deserve some trust, but they have
   been tested here on one cycle.
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

## For later

- **63-day breadth as a second indicator pane.** The share of members above their 63-day average
  (the first study's reading, charted in `index.html`) belongs under the near-lows share in the
  interactive chart, so the two universe readings can be read against each other. Same gestures,
  same bands treatment (25% / 75%), same crosshair.

## Running it

```sh
# Six-year, point-in-time run (the real test). Same key the refresh job uses.
FMP_API_KEY=your_key python3 research/oscillator/oscillator.py
FMP_API_KEY=your_key python3 research/oscillator/derived.py      # the second study

# Without a key: a three-year preview from the committed bars, today's members only.
python3 research/oscillator/oscillator.py
```

A few minutes each once prices are cached. They rewrite `REPORT.md`, `DERIVED.md` and the two
`results*.json` files in this folder and nothing else.
