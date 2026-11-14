// polymarket-faa-attribution-02 entry: an adaptive quantile forecaster. The house baseline is persistence with a fixed
// spread, 0.0025 * sqrt(h). This entry keeps the same plumbing but measures each market's own spread from its last
// 480 one-minute diffs, treats these prices as mean-reverting rather than drifting, and widens the tails past a
// normal's:
//
//   sigma    = 1.4826 * median(|d|) over the last 480 one-minute diffs (a MAD estimate, so one jump does not own it),
//              falling back to half the RMS when that median is exactly zero, clamped to [0.0004, 0.05]; a market
//              with fewer than 30 diffs to measure gets the flat 0.0025;
//   vol(h)   = 1.0 * sigma * h^0.42 for h = 1..240, sub-diffusive instead of a random walk's h^0.5, because these
//              markets mean-revert and so the forecast spread must grow more slowly than sqrt(h);
//   anchor   = median of the last 480 prices, and the median is pulled 40% of the way toward it over the horizon:
//              med(h) = x + (anchor - x) * 0.40 * (1 - exp(-h/720)), abandoned for plain x when the gap is
//              implausibly large (> 6 sigma sqrt(480)), i.e. the anchor is stale;
//   q_tau(h) = clamp(med(h) + z_tau * vol(h), 0, 1), rounded to 6 decimals, with z = +-1.80 at the tails and +-0.70
//              at the quartiles (wider than the normal's 1.6449 and 0.6745), then forced non-decreasing across the
//              row and clamped again.
//
// It runs offline, with no network, under the case's time cap: everything it knows is in the case's prices.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The multiplier of vol(h) at each level, in the same order as QUANTILES: fat tails, so wider than +-1.6449. */
const Z = [-1.8, -0.7, 0, 0.7, 1.8];
/** Price units per square-root minute, for markets too short to measure their own spread. */
const SIGMA_FLOOR_CASE = 0.0025;
/** The spread estimate never leaves this band: a dead-flat market still moves a little, a broken one not this much. */
const SIGMA_MIN = 0.0004;
const SIGMA_MAX = 0.05;
/** Fewer diffs than this and the estimate is noise, so the flat case sigma stands in for it. */
const MIN_DIFFS = 30;
/** How much of the gap to the anchor the median closes, and the time constant it closes it over, in minutes. */
const PULL = 0.4;
const PULL_TAU = 720;
/** Minutes of history the spread and the anchor both look back over. */
const WINDOW = 480;
/** vol(h) = SCALE * sigma * h^EXPONENT: below a random walk's 0.5 because these prices mean-revert. */
const SCALE = 1.0;
const EXPONENT = 0.42;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [lo,hi]. */
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(clamp(x, 0, 1) * 1e6) / 1e6 + 0;

/** The middle of values (the mean of the two middles when there is an even number of them); 0 when empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The root mean square of values. */
function rms(values: number[]): number {
  let acc = 0;
  for (const v of values) acc += v * v;
  return Math.sqrt(acc / values.length);
}

/** A jump-robust spread of the diffs: 1.4826 * median(|d|), or half the RMS when every median-sized diff is 0. */
function robustSigma(ds: number[]): number {
  const m = median(ds.map((d) => Math.abs(d)));
  return m > 0 ? 1.4826 * m : 0.5 * rms(ds);
}

/** The last n entries of ds (all of them when ds is shorter). */
const tail = (ds: number[], n: number): number[] => (ds.length <= n ? ds : ds.slice(ds.length - n));

/** The forecast of one market: horizon rows of the five quantiles, widening from its checkpoint price. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const p = m.prices;
  const x = p[p.length - 1] as number;

  const ds: number[] = [];
  for (let i = 1; i < p.length; i++) ds.push((p[i] as number) - (p[i - 1] as number));
  const recent = tail(ds, WINDOW);

  // Too few diffs to measure a spread from: the case's flat sigma stands in for it.
  const sigma = recent.length < MIN_DIFFS ? SIGMA_FLOOR_CASE : clamp(robustSigma(recent), SIGMA_MIN, SIGMA_MAX);
  // The level the market keeps returning to over the same window, in contrast to where it sits at the checkpoint.
  const anchor = median(tail(p, WINDOW));

  // A gap this wide means the anchor describes a regime the checkpoint has left behind, so it is not used.
  const drift = anchor - x;
  const stale = Math.abs(drift) > 6 * sigma * Math.sqrt(WINDOW);

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const med = stale ? x : x + drift * PULL * (1 - Math.exp(-h / PULL_TAU));
    const vol = SCALE * sigma * Math.pow(h, EXPONENT);
    const row: number[] = [];
    let floor = 0; // the running max, so a row never decreases across its five entries
    for (const z of Z) {
      const v = clamp(Math.max(price6(med + z * vol), floor), 0, 1);
      row.push(v);
      floor = v;
    }
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
