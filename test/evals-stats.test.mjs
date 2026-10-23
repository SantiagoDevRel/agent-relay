import test from 'node:test';
import assert from 'node:assert/strict';
import { holm, bootstrapRatioDifference, mean, median, seededRandom, bootstrapDifference, cohenKappa, spearman, bootstrapCorrelation, excludesZero, stratifiedDifference } from '../evals/stats.mjs';

test('mean and median handle empty and even lists', () => {
  assert.equal(mean([]), null); assert.equal(median([]), null);
  assert.equal(mean([1, 2, 3]), 2); assert.equal(median([4, 1, 3, 2]), 2.5); assert.equal(median([3, 1, 2]), 2);
});

test('seeded random is reproducible', () => {
  const a = seededRandom(7), b = seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('bootstrap difference refuses small groups and finds a clear effect', () => {
  assert.equal(bootstrapDifference([1, 1], Array(20).fill(0)).status, 'insufficient');
  assert.equal(bootstrapDifference([1, 1], Array(20).fill(0)).effect, null);
  const withFactor = Array.from({ length: 40 }, (_, i) => Number(i % 4 !== 0)), without = Array.from({ length: 40 }, (_, i) => Number(i % 4 === 0));
  const result = bootstrapDifference(withFactor, without, { scale: 100 });
  assert.equal(result.status, 'ok'); assert.equal(result.effect, 50);
  assert.ok(excludesZero(result.ci95)); assert.ok(result.ci95[0] < 50 && result.ci95[1] > 50);
  assert.deepEqual(bootstrapDifference(withFactor, without, { scale: 100 }), result);
});

test('kappa matches known values', () => {
  assert.equal(cohenKappa([0, 1, 2], [0, 1, 2]), 1);
  assert.ok(Math.abs(cohenKappa([1, 1, 0, 0], [1, 0, 1, 0])) < 1e-12);
  // Classic 2x2 example: po=0.7, pe=0.5 -> 0.4
  const a = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0], b = [1, 1, 1, 1, 0, 1, 0, 0, 0, 1];
  assert.ok(Math.abs(cohenKappa(a, b) - 0.4) < 1e-9);
  assert.ok(cohenKappa([0, 1, 2, 2], [0, 2, 2, 1], { weights: 'quadratic' }) > cohenKappa([0, 1, 2, 2], [0, 2, 2, 1]));
  assert.throws(() => cohenKappa([1], [1, 2]));
});

test('spearman and its bootstrap', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(bootstrapCorrelation([1, 2], [1, 2]).status, 'insufficient');
  const x = Array.from({ length: 30 }, (_, i) => i), y = x.map(v => v * 2 + (v % 3));
  const result = bootstrapCorrelation(x, y);
  assert.equal(result.status, 'ok'); assert.ok(result.r > 0.95); assert.ok(excludesZero(result.ci95));
});

test('stratified difference removes an effect that only comes from chat length', () => {
  // Long chats (stratum 2) have problems 80% of the time, short ones 20%, with or without the factor.
  const group = (short, long) => [
    ...Array.from({ length: short }, (_, i) => ({ stratum: 1, value: i % 5 === 0 ? 1 : 0 })),
    ...Array.from({ length: long }, (_, i) => ({ stratum: 2, value: i % 5 === 0 ? 0 : 1 })),
  ];
  const withFactor = group(10, 40), withoutFactor = group(40, 10);
  const naive = bootstrapDifference(withFactor.map(i => i.value), withoutFactor.map(i => i.value), { scale: 100 });
  assert.ok(naive.effect > 30 && excludesZero(naive.ci95));
  const adjusted = stratifiedDifference(withFactor, withoutFactor, { scale: 100 });
  assert.equal(adjusted.effect, 0);
  assert.ok(!excludesZero(adjusted.ci95));
  // A real within-stratum effect survives.
  const worse = withFactor.map(i => ({ ...i, value: 1 }));
  assert.ok(stratifiedDifference(worse, withoutFactor, { scale: 100 }).effect > 0);
  // Strata present in only one group are left out of n.
  const lone = stratifiedDifference([...withFactor, { stratum: 9, value: 1 }], withoutFactor);
  assert.equal(lone.nWith, 50);
});

test('stratified difference: minStratum drops thin length groups and p reflects the effect', () => {
  const items = (stratum, values) => values.map(value => ({ stratum, value }));
  const withF = [...items(1, Array(20).fill(1)), ...items(2, [0, 0])], without = [...items(1, Array(20).fill(0)), ...items(2, Array(20).fill(1))];
  const loose = stratifiedDifference(withF, without, { seed: 1 });
  const strict = stratifiedDifference(withF, without, { seed: 1, minStratum: 5 });
  assert.equal(strict.nWith, 20);
  assert.equal(strict.effect, 1);
  assert.ok(loose.effect < strict.effect, 'the thin stratum pulls the loose estimate');
  assert.ok(strict.p < 0.01);
  const flat = stratifiedDifference(items(1, Array(20).fill(0).map((_, i) => i % 2)), items(1, Array(20).fill(0).map((_, i) => i % 2)), { seed: 1 });
  assert.ok(flat.p > 0.5);
});

test('holm adjusts p-values step-down and keeps nulls', () => {
  const adjusted = holm([0.01, 0.04, null, 0.03]);
  assert.deepEqual(adjusted.map(p => (p === null ? null : Math.round(p * 1000) / 1000)), [0.03, 0.06, null, 0.06]);
  assert.deepEqual(holm([]), []);
});

test('bootstrap ratio difference resamples chats and returns an interval around the effect', () => {
  const pairs = (hits, n) => Array.from({ length: n }, (_, i) => [i < hits ? 1 : 0, 1]);
  const clear = bootstrapRatioDifference(pairs(5, 50), pairs(30, 50), { seed: 2 });
  assert.ok(Math.abs(clear.effect - -0.5) < 1e-9);
  assert.ok(clear.ci95[1] < 0 && clear.ci95[0] <= clear.effect && clear.ci95[1] >= clear.effect);
  assert.equal(bootstrapRatioDifference([], pairs(1, 2)).status, 'insufficient');
});
