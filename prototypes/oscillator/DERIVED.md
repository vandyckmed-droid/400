# Derived oscillator: results

Generated 2026-09-05. Mode: **online-six-year**.

SIX-YEAR POINT-IN-TIME RUN: 1162 symbols priced, 2020-09-08 to 2026-09-04; the universe is rebuilt as it stood at each week end, the same reconstruction the backtest uses.

246 week ends from 2021-09-24 to 2026-06-05. Weights fitted on weeks before 2024-02-02 (train), judged from then on (test). Walk-forward readings start 2023-03-24 and are refitted every 13 weeks on outcomes already known.

## What the data weighted

Coefficients of the forward one-month return rank on each descriptor's rank, averaged over the training weeks (Fama-MacBeth). Positive: names high on this reading went on to do better. |t| of 2 or more is the bar for the sparse model.

| descriptor | weight | t | in sparse | own IC 1m train | own IC 1m test | own IC 3m all |
| --- | --- | --- | --- | --- | --- | --- |
| stretch_5 | -0.006 | -0.7 |  | -0.011 | +0.005 | -0.004 |
| stretch_10 | -0.002 | -0.2 |  | -0.006 | +0.006 | -0.005 |
| stretch_21 | +0.018 | +1.1 |  | -0.007 | +0.018 | -0.013 |
| stretch_42 | -0.015 | -0.7 |  | -0.024 | +0.027 | -0.014 |
| stretch_63 | +0.010 | +0.4 |  | -0.020 | +0.011 | -0.010 |
| stretch_126 | -0.009 | -0.3 |  | -0.003 | +0.022 | +0.018 |
| stretch_252 | +0.066 | +2.9 | yes | +0.016 | +0.045 | +0.039 |
| range63 | -0.005 | -0.3 |  | -0.021 | +0.018 | -0.015 |
| range252 | -0.096 | -1.9 |  | -0.004 | +0.040 | +0.023 |
| drawdown | +0.048 | +0.9 |  | +0.001 | +0.024 | +0.018 |
| volregime | -0.011 | -1.1 |  | -0.011 | +0.014 | +0.001 |
| jumpup | -0.002 | -0.2 |  | -0.001 | +0.010 | -0.009 |
| jumpdown | -0.007 | -0.6 |  | -0.009 | -0.006 | -0.018 |
| closepos | -0.003 | -0.2 |  | -0.009 | +0.024 | -0.002 |
| volshock | +0.014 | +2.4 | yes | +0.007 | -0.003 | -0.006 |
| voltrend | -0.005 | -0.6 |  | -0.001 | -0.008 | -0.010 |

## The oscillator against the momentum score

IC = rank correlation between the reading and the return that followed, averaged over week ends; t with the overlap correction. D10−D1 = mean forward return of the top tenth of readings minus the bottom tenth.

| reading | horizon | IC train | IC test | t test | IC all | t all | D10−D1 (all) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| momentum score (site) | 1w | +0.011 | +0.021 | +1.4 | +0.016 | +1.4 | +0.16% |
| momentum score (site) | 2w | +0.001 | +0.030 | +1.7 | +0.016 | +1.2 | +0.33% |
| momentum score (site) | 1m | +0.004 | +0.026 | +1.3 | +0.015 | +0.8 | +0.66% |
| momentum score (site) | 3m | +0.006 | +0.044 | +1.4 | +0.025 | +1.0 | +2.00% |
| derived, all descriptors | 1w | +0.018 | +0.006 | +0.5 | +0.012 | +1.6 | +0.11% |
| derived, all descriptors | 2w | +0.033 | +0.002 | +0.2 | +0.017 | +2.0 | +0.33% |
| derived, all descriptors | 1m | +0.042 | -0.005 | -0.3 | +0.019 | +1.5 | +0.53% |
| derived, all descriptors | 3m | +0.052 | -0.002 | -0.1 | +0.025 | +1.5 | +0.79% |
| derived, sparse | 1w | +0.009 | +0.025 | +1.8 | +0.017 | +1.6 | +0.17% |
| derived, sparse | 2w | +0.006 | +0.036 | +2.3 | +0.021 | +1.7 | +0.38% |
| derived, sparse | 1m | +0.018 | +0.041 | +2.1 | +0.029 | +1.7 | +0.69% |
| derived, sparse | 3m | +0.021 | +0.048 | +1.7 | +0.034 | +1.5 | +1.45% |

## Walk-forward (from 2023-03-24, weights only ever from the past)

| reading | horizon | IC | t | D10−D1 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| momentum score (site) | 1w | +0.015 | +1.1 | +0.21% | -0.016 | +0.028 | +0.007 | +0.058 |
| momentum score (site) | 2w | +0.021 | +1.3 | +0.58% | -0.022 | +0.034 | +0.003 | +0.107 |
| momentum score (site) | 1m | +0.021 | +1.1 | +1.03% | -0.012 | +0.041 | -0.012 | +0.108 |
| momentum score (site) | 3m | +0.042 | +1.5 | +3.04% | +0.018 | +0.060 | +0.041 | +0.045 |
| derived, all | 1w | +0.004 | +0.4 | +0.01% | -0.023 | +0.021 | -0.008 | +0.038 |
| derived, all | 2w | +0.009 | +0.8 | +0.21% | -0.019 | +0.031 | -0.012 | +0.059 |
| derived, all | 1m | +0.007 | +0.5 | +0.33% | -0.031 | +0.041 | -0.026 | +0.076 |
| derived, all | 3m | +0.010 | +0.5 | -0.12% | +0.003 | +0.044 | -0.027 | +0.024 |
| derived, sparse | 1w | +0.015 | +1.2 | +0.13% | -0.018 | +0.031 | +0.007 | +0.055 |
| derived, sparse | 2w | +0.028 | +2.1 | +0.53% | -0.006 | +0.045 | +0.006 | +0.099 |
| derived, sparse | 1m | +0.027 | +1.6 | +0.86% | -0.019 | +0.051 | +0.004 | +0.106 |
| derived, sparse | 3m | +0.043 | +1.9 | +2.09% | +0.014 | +0.073 | +0.038 | +0.042 |

## Deciles of the walk-forward sparse reading (mean forward return, lowest tenth to highest)

| horizon | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1w | +0.3% | +0.2% | +0.2% | +0.2% | +0.3% | +0.4% | +0.3% | +0.3% | +0.3% | +0.4% |
| 2w | +0.4% | +0.4% | +0.3% | +0.4% | +0.6% | +0.7% | +0.6% | +0.7% | +0.7% | +0.9% |
| 1m | +0.8% | +0.9% | +0.8% | +0.8% | +1.1% | +1.4% | +1.3% | +1.4% | +1.5% | +1.6% |
| 3m | +2.6% | +2.5% | +2.7% | +3.1% | +3.4% | +3.8% | +4.0% | +4.3% | +4.0% | +4.7% |

## The reading today (2026-06-05)

Weights in use: stretch_252 +0.027, jumpdown -0.011.

Highest readings: MKSI (100), MTZ (100), FTI (100), ECHO (100), NVT (99), RBC (99), LSCC (99), MLI (99), AMKR (99), WFRD (99), COKE (98), GTLS (98), TPR (98), HAL (98), CW (98).

Lowest readings: BRO (0), VRSK (0), PAYX (0), RYAN (0), RLI (1), WDAY (1), ERIE (1), PCTY (1), HRB (1), VEEV (1), IT (2), GDDY (2), COTY (2), OPCH (2), HRL (2).

## Universe-level readings derived from the same descriptors

Each aggregate against the equal-weight universe's forward return. Bands are the outer tenths of the training half's own readings, not hand-set. corr over the whole sample (train | test), t with the overlap correction, then mean forward return below the low band, between, and above the high band, with week counts.

| reading | latest | bands | horizon | corr | train | test | t | low (wks) | middle (wks) | high (wks) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| median_stretch_21 | -0.073 | -0.832 / +0.906 | 1m | -0.22 | -0.17 | -0.32 | -2.7 | +2.86% (19) | +0.69% (212) | -0.66% (15) |
| median_stretch_21 | -0.073 | -0.832 / +0.906 | 3m | -0.23 | -0.26 | -0.30 | -2.5 | +5.85% (19) | +1.78% (212) | +1.54% (15) |
| median_stretch_63 | +0.086 | -0.587 / +0.637 | 1m | -0.24 | -0.26 | -0.30 | -2.1 | +4.81% (17) | +0.59% (201) | -0.34% (28) |
| median_stretch_63 | +0.086 | -0.587 / +0.637 | 3m | -0.36 | -0.38 | -0.43 | -2.5 | +8.42% (17) | +1.90% (201) | -0.50% (28) |
| share_capitulating | +0.008 | +0.000 / +0.064 | 1m | +0.14 | +0.20 | +0.06 | +2.6 | n/a (0) | +0.62% (224) | +2.38% (22) |
| share_capitulating | +0.008 | +0.000 / +0.064 | 3m | +0.19 | +0.36 | -0.03 | +1.5 | n/a (0) | +1.82% (224) | +4.73% (22) |
| share_near_lows | +0.122 | +0.022 / +0.243 | 1m | +0.22 | +0.22 | +0.22 | +3.1 | -2.27% (12) | +0.69% (220) | +4.71% (14) |
| share_near_lows | +0.122 | +0.022 / +0.243 | 3m | +0.32 | +0.34 | +0.32 | +3.4 | -3.36% (12) | +1.97% (220) | +8.50% (14) |
| share_near_highs | +0.103 | +0.019 / +0.205 | 1m | -0.23 | -0.19 | -0.40 | -2.3 | +5.07% (14) | +0.83% (187) | -0.76% (45) |
| share_near_highs | +0.103 | +0.019 / +0.205 | 3m | -0.25 | -0.27 | -0.43 | -2.3 | +8.61% (14) | +2.16% (187) | -0.28% (45) |
| median_drawdown | -0.154 | -0.260 / -0.111 | 1m | -0.22 | -0.22 | -0.33 | -2.4 | +7.23% (15) | +0.56% (178) | -0.30% (53) |
| median_drawdown | -0.154 | -0.260 / -0.111 | 3m | -0.30 | -0.36 | -0.46 | -2.4 | +7.89% (15) | +2.10% (178) | +0.38% (53) |
| dispersion_21 | +1.119 | +0.872 / +1.327 | 1m | -0.14 | -0.12 | -0.19 | -2.0 | +2.34% (17) | +0.79% (184) | +0.15% (45) |
| dispersion_21 | +1.119 | +0.872 / +1.327 | 3m | -0.10 | -0.09 | -0.22 | -1.5 | +4.45% (17) | +2.18% (184) | +0.79% (45) |
| median_volregime | +0.965 | +0.782 / +1.134 | 1m | +0.09 | +0.20 | -0.02 | +1.1 | -0.38% (33) | +0.96% (187) | +0.96% (26) |
| median_volregime | +0.965 | +0.782 / +1.134 | 3m | +0.15 | +0.08 | +0.24 | +1.3 | +0.36% (33) | +2.14% (187) | +3.80% (26) |
| median_closepos | +0.491 | +0.452 / +0.557 | 1m | -0.14 | -0.21 | -0.05 | -1.6 | +1.97% (20) | +0.93% (210) | -2.73% (16) |
| median_closepos | +0.491 | +0.452 / +0.557 | 3m | -0.19 | -0.40 | +0.10 | -1.9 | +6.13% (20) | +2.21% (210) | -4.62% (16) |
| median_volshock | +0.008 | -0.192 / +0.177 | 1m | +0.10 | +0.23 | -0.05 | +1.0 | +0.97% (18) | +0.60% (204) | +2.16% (24) |
| median_volshock | +0.008 | -0.192 / +0.177 | 3m | +0.09 | +0.18 | -0.11 | +1.3 | +0.80% (18) | +2.12% (204) | +2.72% (24) |

### Combined universe reading: share_near_lows (+), median_stretch_21 (-), share_capitulating (+)

The top 3 aggregates by training t, each as a percentile of the training distribution, sign-aligned so high means "expect more", averaged. Latest 60%.

| horizon | corr | train | test | t | reading > 80% (wks) | reading < 20% (wks) |
| --- | --- | --- | --- | --- | --- | --- |
| 1w | +0.08 | -0.00 | +0.18 | +1.4 | +0.62% (30) | -0.02% (15) |
| 2w | +0.15 | +0.09 | +0.23 | +1.8 | +1.58% (30) | -0.15% (15) |
| 1m | +0.22 | +0.21 | +0.24 | +2.5 | +3.78% (30) | -1.85% (15) |
| 3m | +0.29 | +0.34 | +0.25 | +3.0 | +6.58% (30) | -0.52% (15) |

**Reading above 80% ("expect more")**, 12 spells, measured from the first week end of each

| first week end | weeks | next 1m | next 3m |
| --- | --- | --- | --- |
| 2022-01-28 | 1 | +0.4% | -2.7% |
| 2022-04-29 | 4 | +1.0% | +0.2% |
| 2022-06-17 | 1 | +8.3% | +7.8% |
| 2022-07-01 | 2 | +7.8% | -5.2% |
| 2022-09-16 | 5 | -4.1% | +2.9% |
| 2023-03-10 | 3 | +2.1% | +3.3% |
| 2023-09-29 | 5 | -6.5% | +12.0% |
| 2024-06-14 | 1 | +6.7% | +7.5% |
| 2024-12-27 | 3 | +3.7% | -4.4% |
| 2025-04-04 | 1 | +8.4% | +19.8% |
| 2025-10-10 | 1 | +2.1% | +9.5% |
| 2026-03-13 | 3 | +5.4% | +10.3% |
| **mean** | | +3.0% | +5.1% |
| **positive** | | 10/12 | 9/12 |

**Reading below 20% ("expect less")**, 7 spells, measured from the first week end of each

| first week end | weeks | next 1m | next 3m |
| --- | --- | --- | --- |
| 2021-12-31 | 1 | -4.0% | -1.8% |
| 2022-08-12 | 1 | -7.5% | -4.5% |
| 2023-01-20 | 3 | +1.4% | -2.8% |
| 2023-07-21 | 2 | -4.6% | -10.9% |
| 2023-12-01 | 6 | +4.1% | +9.0% |
| 2024-03-28 | 1 | -4.3% | -3.7% |
| 2025-05-16 | 1 | -2.3% | +3.8% |
| **mean** | | -2.5% | -1.6% |
| **positive** | | 2/7 | 2/7 |

