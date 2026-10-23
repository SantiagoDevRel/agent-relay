// Shared, dependency-free statistics for Relay Evals. Deterministic: every
// resampling takes an explicit seed so reports are reproducible.

export const MIN_N = 10;

export function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Mulberry32: small seeded PRNG returning [0, 1).
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const resample = (values, random) => values.map(() => values[Math.floor(random() * values.length)]);

// Effect = mean(withFactor) - mean(withoutFactor) for 0/1 (or numeric) outcomes,
// with a percentile bootstrap interval. Returns null fields when either group has n < minN.
export function bootstrapDifference(withFactor, withoutFactor, { iterations = 2000, seed = 42, minN = MIN_N, scale = 1 } = {}) {
  const nWith = withFactor.length, nWithout = withoutFactor.length;
  if (nWith < minN || nWithout < minN) return { effect: null, ci95: null, nWith, nWithout, status: 'insufficient' };
  const random = seededRandom(seed), samples = [];
  for (let i = 0; i < iterations; i++) samples.push(mean(resample(withFactor, random)) - mean(resample(withoutFactor, random)));
  samples.sort((a, b) => a - b);
  const round = v => Math.round(v * scale * 100) / 100;
  return { effect: round(mean(withFactor) - mean(withoutFactor)), ci95: [round(quantile(samples, 0.025)), round(quantile(samples, 0.975))], nWith, nWithout, status: 'ok' };
}

// Same difference, compared only inside strata (for example chat length) so a factor
// that just goes with longer chats is not credited with their extra problems.
// Items are { stratum, value }. Strata with fewer than minStratum items on either side
// are left out (a stratum with one chat adds no resampling variance, so it would make the
// interval too narrow), and the effect is the per-stratum difference weighted by the
// stratum's size; resampling stays inside each stratum. p is the two-sided bootstrap
// p-value of "no difference" (share of resamples on the other side of zero, doubled).
export function stratifiedDifference(withFactor, withoutFactor, { iterations = 2000, seed = 42, minN = MIN_N, minStratum = 1, scale = 1 } = {}) {
  const groups = new Map();
  for (const [items, side] of [[withFactor, 'with'], [withoutFactor, 'without']]) for (const { stratum, value } of items) {
    if (!groups.has(stratum)) groups.set(stratum, { with: [], without: [] });
    groups.get(stratum)[side].push(value);
  }
  const strata = [...groups.values()].filter(g => g.with.length >= Math.max(1, minStratum) && g.without.length >= Math.max(1, minStratum));
  const nWith = strata.reduce((s, g) => s + g.with.length, 0), nWithout = strata.reduce((s, g) => s + g.without.length, 0);
  if (nWith < minN || nWithout < minN) return { effect: null, ci95: null, nWith, nWithout, status: 'insufficient' };
  const total = nWith + nWithout;
  const weighted = pick => strata.reduce((s, g) => s + ((g.with.length + g.without.length) / total) * pick(g), 0);
  const random = seededRandom(seed), samples = [];
  for (let i = 0; i < iterations; i++) samples.push(weighted(g => mean(resample(g.with, random)) - mean(resample(g.without, random))));
  samples.sort((a, b) => a - b);
  const round = v => Math.round(v * scale * 100) / 100;
  const below = samples.filter(v => v <= 0).length, above = samples.filter(v => v >= 0).length;
  const p = Math.min(1, (2 * Math.min(below, above)) / samples.length);
  return { effect: round(weighted(g => mean(g.with) - mean(g.without))), ci95: [round(quantile(samples, 0.025)), round(quantile(samples, 0.975))], p, nWith, nWithout, status: 'ok' };
}

// Difference of two ratios of sums (for example corrections per prompt this week minus
// last week). Items are [numerator, denominator] per chat; chats are resampled, so chats
// with many prompts weigh as much as they do in the ratio. Effect and interval use the
// ratio's own units (callers scale them).
export function bootstrapRatioDifference(current, previous, { iterations = 2000, seed = 42 } = {}) {
  const ratio = pairs => {
    const den = pairs.reduce((s, [, d]) => s + d, 0);
    return den ? pairs.reduce((s, [n]) => s + n, 0) / den : null;
  };
  const a = ratio(current), b = ratio(previous);
  if (a === null || b === null) return { effect: null, ci95: null, status: 'insufficient' };
  const random = seededRandom(seed), samples = [];
  for (let i = 0; i < iterations; i++) {
    const x = ratio(resample(current, random)), y = ratio(resample(previous, random));
    if (x !== null && y !== null) samples.push(x - y);
  }
  samples.sort((p, q) => p - q);
  return { effect: a - b, ci95: [quantile(samples, 0.025), quantile(samples, 0.975)], status: 'ok' };
}

// Holm step-down adjustment of p-values (same order as the input; null stays null), so
// testing many factors a week does not turn chance into "validated" findings.
export function holm(pValues) {
  const order = pValues.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const adjusted = pValues.map(() => null);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (order.length - rank) * p)); adjusted[i] = running; });
  return adjusted;
}

// Cohen's kappa for two raters over the same items. weights: 'none' | 'linear' | 'quadratic'
// (weighted kappa for ordinal scores such as the 0-2 rubric criteria).
export function cohenKappa(a, b, { weights = 'none' } = {}) {
  if (a.length !== b.length) throw new Error('Kappa needs paired ratings.');
  if (!a.length) return null;
  const categories = [...new Set([...a, ...b])].sort((x, y) => x - y);
  const k = categories.length, index = new Map(categories.map((c, i) => [c, i]));
  if (k === 1) return 1;
  const weight = (i, j) => weights === 'none' ? (i === j ? 0 : 1)
    : weights === 'linear' ? Math.abs(i - j) / (k - 1) : ((i - j) / (k - 1)) ** 2;
  const observed = Array.from({ length: k }, () => Array(k).fill(0));
  a.forEach((value, n) => { observed[index.get(value)][index.get(b[n])] += 1 / a.length; });
  const rows = observed.map(row => row.reduce((s, v) => s + v, 0));
  const cols = categories.map((_, j) => observed.reduce((s, row) => s + row[j], 0));
  let po = 0, pe = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { po += weight(i, j) * observed[i][j]; pe += weight(i, j) * rows[i] * cols[j]; }
  return pe === 0 ? 1 : 1 - po / pe;
}

const ranks = values => {
  const order = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), result = Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let t = i; t <= j; t++) result[order[t][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return result;
};

export function pearson(x, y) {
  if (x.length !== y.length || x.length < 2) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export const spearman = (x, y) => pearson(ranks(x), ranks(y));

// Spearman correlation with a paired percentile bootstrap interval.
export function bootstrapCorrelation(x, y, { iterations = 2000, seed = 42, minN = MIN_N } = {}) {
  const n = x.length;
  if (n < minN) return { r: null, ci95: null, n, status: 'insufficient' };
  const random = seededRandom(seed), samples = [];
  for (let i = 0; i < iterations; i++) {
    const pick = x.map(() => Math.floor(random() * n));
    const r = spearman(pick.map(p => x[p]), pick.map(p => y[p]));
    if (r !== null) samples.push(r);
  }
  samples.sort((a, b) => a - b);
  const r = spearman(x, y), round = v => Math.round(v * 1000) / 1000;
  if (r === null || !samples.length) return { r: null, ci95: null, n, status: 'insufficient' };
  return { r: round(r), ci95: [round(quantile(samples, 0.025)), round(quantile(samples, 0.975))], n, status: 'ok' };
}

export const excludesZero = ci => Array.isArray(ci) && (ci[0] > 0 || ci[1] < 0);
