---
name: research
description: Read-only research mode. Answer questions, brainstorm, and run small tests against live FMP data and the repo's own pipeline code without editing, committing, branching or pushing anything. Use when the owner types /research or asks a "does X predict Y" style question.
---

# /research — read-only mode

The owner is asking a question, brainstorming, or wants a small test run. This session must
leave the repository exactly as it found it, so it can run alongside build sessions with no risk
of a stray commit.

## Rules

- **Read anything, change nothing.** Read any file in the repo. Never edit a tracked file, never
  run `git add`, `git commit`, `git checkout -b`, `git push`, and never merge or open a PR.
- **Work in the scratch folder** named in the environment prompt. Every script, cache file and
  output goes there.
- **Use the key from the environment** (`API_KEY`). Never print it, write it to a file, or put
  it in a URL that ends up in the chat.
- **Keep API calls small.** A few names or one endpoint is a test. A full-universe fetch of six
  years of prices is a rebuild; do not do that here. If a test needs it, say so and stop.
- **Report in the chat.** Tables and plain-English findings. No files are added to the repo.
- **A finding that should become a feature** goes through `build.py` in a separate build
  session. Say so and stop; do not start the build here.

## Reusing the pipeline

Import the pipeline instead of copying its maths. Point its two on-disk writes at the scratch
folder first, otherwise fetches land in `.cache/` and universe snapshots overwrite `data/`.

```python
import sys, pathlib
sys.path.insert(0, "/home/user/400/scripts")       # adjust if the repo lives elsewhere
import build, universes

scratch = pathlib.Path("<scratch folder>")
build.CACHE = scratch / "cache"                      # 12-hour fetch cache
build.DATA = scratch / "data"                        # where snapshot() would write
```

What is useful from there:

- `build.cached_fmp(key, endpoint, **params)` — one FMP call, cached 12 h in scratch.
- `build.fetch_prices(symbol, start)` — adjusted daily closes as `(date, close)` tuples.
- `build.vol_adjusted_momentum`, `build.residual_momentum`, `build.percentiles`,
  `build.rank_block`, `build.legs_at` — the scoring maths, exactly as published.
- The committed `data/` files are the cheapest source: `data/latest.json` for today's ranking,
  `data/history/<key>.json` for 36 month-ends, `data/bars/<SYMBOL>.json` for three years of bars,
  `data/universe.json` and `data/sp500.json` for membership. Read them directly rather than
  calling `universes.load_core()` / `load_sp500()`, which fetch and rewrite the snapshots.

## Before finishing

Run `git status --porcelain` in the repo. It must print nothing. If it does not, restore the
files (`git checkout -- <file>`) and say what happened.
