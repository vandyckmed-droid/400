# Moving-average cross prototype

A design study, not a feature. Nothing in this folder is loaded by the site or run by the
refresh job. It asks one question of the universe and six years of its prices: **which two
moving-average durations come closest to buying every valley and selling every peak, and how
close is that?**

Files:

| File | What it is |
| --- | --- |
| `ma_cross.py` | The study. Standard library only. Reads prices through the same client as the backtest, never writes under `data/`. |
| `REPORT.md` | Every table the script produces, regenerated on each run. |
| `results.json` | The same numbers, machine-readable: every pair, every window, the grids, the picks. |

## What was tested

A crossover holds a name while its fast average sits above its slow average and steps aside
when it drops below (long or cash; no shorting). Every pair from a grid of twelve fast lengths
(1, 3, 5, 8, 10, 13, 15, 20, 25, 30, 40, 50 days; 1 means the close itself) and thirteen slow
lengths (10 to 200 days), fast shorter than slow, as simple and as exponential averages: 254
pairs. Every pair was judged from the same bar, after a 200-day warm-up, so none had extra days.
Each switch cost 0.1% one way.

Prices were the six-year, point-in-time universe the backtest uses: 1,157 names that were ever
members from September 2020, each counted toward the universe curve only on the days it was a
member. That leaves 1,305 trading days judged, June 2021 to September 2026. Durations were chosen
on the first half (to January 2024, which holds the 2022 bear market) and checked on the second
(2024 onward, mostly a bull market).

"Perfect timing" was defined after the fact: a zigzag marks every peak and valley of every name
with a reversal of at least 20% (10% and 30% were run alongside). A trader who bought each valley
and sold each peak earns the "ideal" return. Each pair was scored three ways:

1. **Capture**: the share of the ideal return the crossover kept, net of costs. This charges the
   pair for both of its faults at once: buying late after a valley and selling late after a
   peak (lag), and switching on moves that were not turns (whipsaw).
2. **Turn detection**: a cross counts as a hit when it is the first cross after a real turn, in
   the right direction, before the next turn. Precision (hits over all crosses), recall (hits
   over all turns), and their harmonic mean F1. Plus, for every hit, how many days after the
   turn it came and how far above the low it bought or below the top it sold.
3. **The universe curve**: every member held under the rule, equal weight, daily, against the
   same universe held outright. Return, volatility, worst fall.

## What the data says

**No crossover captures more than a sliver of perfect timing, and none beats holding.** The
perfect 20%-turn trader would have made about 73% a year per name. Holding outright kept 8% of
that. The best crossover in the grid, SMA 50/200, kept 3%; most kept nothing or lost money. On the
universe curve, holding outright returned 8.0% a year with a worst fall of 22%; the best pair,
SMA 50/200, returned 2.8% a year with a worst fall of 13%. Every crossover trades return for a
shallower fall, and none of them trades well. In 2022, the year a cross exists for, the
universe fell 11.5% and SMA 50/200 fell 8.4%.

**For making money, there is no stable optimum.** The pair chosen on the first half by capture
(SMA 8/15, a fast pair that was least bad through 2022) ranked 232nd of 254 on the second half.
The rank correlation between the two halves' orderings of all 254 pairs is −0.04 by capture and
−0.28 by the curve's return: the order did not just weaken, it reversed. In a bear market the
fastest pairs lose least; in a bull market the slowest pairs lose least to holding. Whatever
pair is picked from history is a bet on which kind of market comes next. Fitting each name its
own best pair on the first half did not help either: on the second half it beat the single
universal pair on 51% of names, a coin flip, and both were far behind holding (2% and −1%
capture against 16%).

**For marking the turns, there is a clear and stable optimum, and it comes with a price.** The
turn-detection ordering held across the two halves (rank correlation +0.96). The best detectors
sit on a ridge of exponential pairs around **EMA 40/60** (40/50, 40/60, 30/75, 50/60 and 40/75
all score F1 0.51). EMA 40/60 hits 61% of real 20% turns, 44% of its crosses are hits, and it
raises 0.76 false alarms per real turn. The price is lag: on a typical hit it buys about 33 days after the
valley, 24% above the low, and sells about 29 days after the peak, 17% below the top (medians;
the means are 36 days and 28%, 32 days and 18%). A 20% turn is recognised only once most of it
has happened. The best simple-average detectors (SMA 15/125,
20/100) score 0.48 with the same lag.

**Faster means closer to the turn but more false alarms; there is no free lunch on the ladder.**

| false alarms per real turn | best pair in the band | buys, after the low | sells, below the top | curve a year | worst fall |
| --- | --- | --- | --- | --- | --- |
| under 0.5 | SMA 50/200 | 68 days, +35% | 61 days, −21% | +2.8% | −13% |
| 0.5 to 1 | SMA 20/200 | 50 days, +34% | 45 days, −20% | +1.8% | −16% |
| 1 to 2 | EMA 8/200 | 35 days, +27% | 33 days, −18% | +1.1% | −17% |
| 2 to 4 | SMA 10/25 | 12 days, +15% | 11 days, −11% | +1.4% | −19% |
| 4 and over | SMA 20/25 | 14 days, +15% | 13 days, −12% | +2.1% | −17% |

The fastest pair in the grid, SMA 8/15, buys 8 days after the low and 10% above it, and sells
8 days after the top and 8% below it, but raises nearly seven false alarms per real turn and
switches 19 times a year per name.

**The right detector scales with the size of turn you care about.** For 10% turns the best
detector is EMA 15/20 to 15/25 (buys about 14% above the low); for 20% turns the EMA 40/50 to
40/60 ridge (27% above); for 30% turns EMA 50/200 (44% above). Whatever the turn size, the crossover recognises it after
roughly two-thirds of the move.

## The recommended durations

If a crossover is ever drawn on the price chart, draw **EMA 40 / EMA 60**. It is the most
reliable marker of the 20% turns a three-year daily chart shows, its ranking held in both halves
of the sample, and it crosses about 3.4 times a year per name, so the chart is not cluttered.
For a simple-average version, SMA 20/100 is the nearest equivalent.

It should be presented as what it is: a label for a turn that has already happened, arriving
about five weeks late, right three times in five. It is not a signal. Acting on it across
this universe over six years would have earned less than holding, in both halves and in every
kind of market. The site's momentum ranking and the two universe readings from the oscillator
study carry information; this does not.

The sensible alternative is to draw nothing new. The chart already carries a 200-day regression
channel, which marks trend and stretch without pretending to time turns.

## Caveats, in order of importance

1. **A turn is only a turn in hindsight.** The zigzag knows where every peak and valley was
   because it saw what came after. Any real-time rule pays for not knowing, and lag is the
   currency. The study measures that price; it cannot remove it.
2. **Six years is one cycle.** The split puts the 2022 bear market in the first half and the
   2024–2026 bull market in the second, which is exactly why the profit ordering reversed. A
   longer history would show more regimes, not a different answer.
3. **Costs are a guess.** 0.1% a side is modest for mid-caps. A higher figure punishes the fast
   pairs further and changes nothing about the slow ones.
4. **Long or cash only.** A version that shorts on the down cross was not tested; on this
   universe over these years it would have done worse.

## Running it

```sh
# Six-year, point-in-time run (the real test). Same key the refresh job uses. About five minutes.
FMP_API_KEY=your_key python3 prototypes/ma-cross/ma_cross.py

# Without a key: a three-year preview from the committed bars, today's members only.
python3 prototypes/ma-cross/ma_cross.py
```

It rewrites `REPORT.md` and `results.json` in this folder and nothing else.
