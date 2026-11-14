# polymarket-faa-attribution-02 entry

Forecasts the Yes price of each Polymarket market in a case as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95) at every
one of the 240 minutes after the case's checkpoint. Scored by mean pinball loss, lower is better; the house baseline is
persistence with a fixed spread of `0.0025 * sqrt(h)` and normal quantiles.

## What it does

For each market it reads the checkpoint price `x` (the last price in `prices`), measures that market's own minute-to-
minute spread, and emits rows

    q_tau(h) = clamp(med(h) + z_tau * vol(h), 0, 1),  h = 1..240

with the five values forced non-decreasing and rounded to 6 decimals.

## How it works

1. **Spread.** `sigma` is one jump-robust estimate of the diffs `d[i] = p[i] - p[i-1]` over the last 240 of them,
   `1.4826 * median(|d|)` (a MAD estimate, so a single jump does not own the number), falling back to half the RMS
   when that median is exactly 0:

       sigma = clamp(robustSigma(last 240 diffs), 0.0004, 0.05)

   Markets with fewer than 30 diffs get the flat `0.0025`.
2. **Anchor.** `anchor` is the median of the last 240 prices, the level the market keeps returning to, and the median
   walks 70% of the way from `x` toward it:

       med(h) = x + (anchor - x) * 0.70 * (1 - exp(-h / 720))

   If `|anchor - x| > 6 * sigma * sqrt(240)` the anchor is stale and `med(h) = x` instead.
3. **Volatility path.** `vol(h) = 0.65 * sigma * h^0.33` — sub-diffusive, below a random walk's `h^0.5`, because these
   prices mean-revert: the forecast spread grows more slowly than `sqrt(h)`.
4. **Quantiles.** `z = [-1.80, -0.70, 0, 0.70, 1.80]` for `[0.05, 0.25, 0.5, 0.75, 0.95]`: wider than a normal's
   ±1.6449 at the 5% and 95% rows so they carry the jump risk, and slightly wider than ±0.6745 at the quartiles.

Deterministic: no `Math.random`, no `Date`, inputs read in sorted name order, so the same input gives the same bytes.

## How to run locally

Node 22, no packages, no network. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for the grader's `/input` and
`/output`:

    mkdir -p out
    MAKEFUN_INPUT_DIR=../polymarket-faa-attribution-02-kit/input \
    MAKEFUN_OUTPUT_DIR=../out \
    node main.ts

On Windows (git-bash), with the whole command on one line:

    mkdir -p C:/Users/raman/makefun/faa/out && MAKEFUN_INPUT_DIR=C:/Users/raman/makefun/faa/polymarket-faa-attribution-02-kit/input MAKEFUN_OUTPUT_DIR=C:/Users/raman/makefun/faa/out node main.ts

Every `<id>.in` in the input directory gets an `<id>.out` holding
`{"forecasts":[{"id","q"}]}` — every market of the case exactly once, 240 rows of five non-decreasing finite numbers
in `[0,1]`, well under the 1 MiB cap. One run handles one case in well under the 8 second cap.

## Layout

    main.ts      the entry point (node:fs and node:path only)
