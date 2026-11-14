// polymarket-faa-attribution-02 entry: an adaptive quantile forecaster. The house baseline is persistence with a fixed
// spread, 0.0025 * sqrt(h). This entry keeps the same plumbing but measures each market's own spread from its recent
// prices, tilts the median back toward a longer-run level, and widens the tails past a normal's:
//
//   sigma    = 0.55 * robustSigma(last 120 diffs) + 0.30 * robustSigma(last 720) + 0.15 * robustSigma(all),
//              robustness being 1.4826 * median(|d|) (a MAD estimate, so one jump does not own the spread), falling back
//              to half the RMS when the median is exactly zero, clamped to [0.00035, 0.05];
//   anchor   = median of the last 1440 prices (a day), and the median is pulled a fifth of the way to it over the
//              horizon: med(h) = x + (anchor - x) * 0.20 * (1 - exp(-h/720)), abandoned for plain x when the gap is
//              implausibly large (> 6 sigma sqrt(H)), i.e. the anchor is stale;
//   vol(h)   = sigma * h^0.54, slightly super-diffusive because price jumps cluster;
//   q_tau(h) = clamp(med(h) + z_tau * vol(h), 0, 1), rounded to 6 decimals, with z = +-1.85 and +-0.72 (fatter tails
//              than the normal's 1.6449 and 0.6745), then forced non-decreasing across the row and clamped again.
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
const Z = [-1.85, -0.72, 0, 0.72, 1.85];
/** Price units per square-root minute, for markets too short to measure their own spread. */
const SIGMA_FLOOR_CASE = 0.0025;
/** The spread estimate never leaves this band: a dead-flat market still moves a little, a broken one not this much. */
const SIGMA_MIN = 0.00035;
const SIGMA_MAX = 0.05;
/** How much of the gap to the anchor the median closes, and the time constant it closes it over, in minutes. */
const PULL = 0.2;
const PULL_TAU = 720;
/** Points of history the spread and the anchor look back over. */
const SHORT = 120;
const LONG = 720;
const ANCHOR_WINDOW = 1440;

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

  let sigma: number;
  let anchor: number;
  if (p.length < 6) {
    sigma = SIGMA_FLOOR_CASE;
    anchor = x;
  } else {
    const ds: number[] = [];
    for (let i = 1; i < p.length; i++) ds.push((p[i] as number) - (p[i - 1] as number));
    const s = 0.55 * robustSigma(tail(ds, SHORT)) + 0.3 * robustSigma(tail(ds, LONG)) + 0.15 * robustSigma(ds);
    sigma = clamp(s, SIGMA_MIN, SIGMA_MAX);
    anchor = median(tail(p, ANCHOR_WINDOW));
  }

  // A gap this wide means the anchor describes a regime the checkpoint has left behind, so it is not used.
  const drift = anchor - x;
  const stale = Math.abs(drift) > 6 * sigma * Math.sqrt(horizon);

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const med = stale ? x : x + drift * PULL * (1 - Math.exp(-h / PULL_TAU));
    const vol = sigma * Math.pow(h, 0.54);
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
