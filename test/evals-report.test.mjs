// E6 weekly report: week boundaries, KPI math, predictors, honest prose, privacy,
// HTML structure and atomic writing. Synthetic metrics only, isolated temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { weekPeriod, buildReport, renderReportHtml, writeReport, trendOf, rankPredictors, redactLight } from '../evals/report.mjs';
import { validate, assertValid } from '../evals/schema.mjs';
import { chatMetrics, many, NOW, THIS_WEEK, LAST_WEEK, OLDER, FAKE_ROOT } from './fixtures/evals/report/synthetic.mjs';

const kpi = (report, id) => report.kpis.find(k => k.id === id);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-report-'));

// A week with enough data for every KPI.
function sufficientWeek(startedAt, { corrections = 3, falseDone = 2, verified = 7, fixed = 1 } = {}) {
  return many(10, i => ({
    startedAt, userTurns: 1,
    corrections: i < corrections ? [{ category: 'wrong-result', excerpt: `synthetic: it still fails ${i}` }] : [],
    doneClaims: 1, falseDone: i < falseDone ? 1 : 0,
    commits: [i < verified], commitsChecked72h: 1, commitsFixedOrReverted72h: i < fixed ? 1 : 0,
  }));
}

test('weekPeriod uses Bogota Monday boundaries', () => {
  // Sunday Oct 25, 23:30 in Bogota (UTC-5) is Monday 04:30 UTC: still the week of Oct 19.
  const sunday = weekPeriod(new Date('2026-10-26T04:30:00.000Z'));
  assert.deepEqual(sunday.period, { start: '2026-10-19T05:00:00.000Z', end: '2026-10-26T05:00:00.000Z', label: 'Oct 19 – Oct 25, 2026' });
  assert.deepEqual(sunday.previousPeriod, { start: '2026-10-12T05:00:00.000Z', end: '2026-10-19T05:00:00.000Z', label: 'Oct 12 – Oct 18, 2026' });
  // Monday Oct 26, 00:30 in Bogota starts the next week.
  const monday = weekPeriod(new Date('2026-10-26T05:30:00.000Z'));
  assert.equal(monday.period.start, '2026-10-26T05:00:00.000Z');
  assert.equal(monday.period.end, '2026-11-02T05:00:00.000Z');
  assert.equal(monday.previousPeriod.start, '2026-10-19T05:00:00.000Z');
  // Year boundary: Friday Jan 1, 2027 belongs to the week of Monday Dec 28, 2026.
  const year = weekPeriod(new Date('2027-01-01T12:00:00.000Z'));
  assert.deepEqual(year.period, { start: '2026-12-28T05:00:00.000Z', end: '2027-01-04T05:00:00.000Z', label: 'Dec 28, 2026 – Jan 3, 2027' });
  assert.equal(year.previousPeriod.start, '2026-12-21T05:00:00.000Z');
  // The time zone is a real parameter, not a hardcoded offset.
  assert.equal(weekPeriod(new Date('2026-10-26T04:30:00.000Z'), { timeZone: 'UTC' }).period.start, '2026-10-26T00:00:00.000Z');
});

test('KPI math: exactly four KPIs in order with correct values', () => {
  const report = buildReport({ metrics: sufficientWeek(THIS_WEEK), now: NOW });
  assert.deepEqual(report.kpis.map(k => k.id), ['correction-rate', 'false-done-rate', 'verified-commit-rate', 'fix-revert-rate']);
  assert.deepEqual(report.kpis.map(k => [k.value, k.unit, k.goodDirection, k.n, k.insufficient]), [
    [3, 'per10', 'down', 10, false], [20, 'percent', 'down', 10, false],
    [70, 'percent', 'up', 10, false], [10, 'percent', 'down', 10, false],
  ]);
  for (const k of report.kpis) assert.ok(k.meaning.length > 20);
  assert.deepEqual(validate('report', report), []);
});

test('KPI insufficient at n = 9, sufficient at n = 10', () => {
  const nine = buildReport({ metrics: sufficientWeek(THIS_WEEK).slice(0, 9), now: NOW });
  for (const k of nine.kpis) { assert.equal(k.n, 9); assert.equal(k.insufficient, true); assert.equal(k.value, null); assert.equal(k.trend, 'unknown'); }
  const ten = buildReport({ metrics: sufficientWeek(THIS_WEEK), now: NOW });
  for (const k of ten.kpis) { assert.equal(k.n, 10); assert.equal(k.insufficient, false); assert.notEqual(k.value, null); }
});

test('trend rules: better or worse only when the interval of the difference excludes zero', () => {
  // hits of n chats, one unit each: raw is hits per 10.
  const s = (hits, n = 40) => ({ raw: (hits / n) * 10, n, pairs: Array.from({ length: n }, (_, i) => [i < hits ? 1 : 0, 1]) });
  assert.equal(trendOf(s(30), s(10), 'down'), 'worse');
  assert.equal(trendOf(s(10), s(30), 'down'), 'better');
  assert.equal(trendOf(s(30), s(10), 'up'), 'better');
  // 3 of 10 vs 6 of 10 is a 50% relative drop, but the interval includes zero.
  assert.equal(trendOf(s(3, 10), s(6, 10), 'down'), 'same');
  assert.equal(trendOf(s(0), s(0), 'down'), 'same');
  assert.equal(trendOf(s(15), { raw: 1, n: 9, pairs: [] }, 'down'), 'unknown');
  assert.equal(trendOf({ raw: 1.5, n: 9, pairs: [] }, s(10), 'down'), 'unknown');

  const metrics = [...sufficientWeek(THIS_WEEK, { corrections: 1, verified: 10 }), ...sufficientWeek(LAST_WEEK, { corrections: 9, verified: 2 })];
  const report = buildReport({ metrics, now: NOW });
  assert.equal(kpi(report, 'correction-rate').trend, 'better');
  assert.equal(kpi(report, 'correction-rate').previous, 9);
  assert.equal(kpi(report, 'verified-commit-rate').trend, 'better');
  assert.equal(kpi(report, 'false-done-rate').trend, 'same');
  const noisy = buildReport({ metrics: [...sufficientWeek(THIS_WEEK, { corrections: 3 }), ...sufficientWeek(LAST_WEEK, { corrections: 6 })], now: NOW });
  assert.equal(kpi(noisy, 'correction-rate').trend, 'same');
  assert.ok(noisy.summary.includes('No measure clearly improved compared with last week.'));
  const worse = buildReport({ metrics: [...sufficientWeek(THIS_WEEK, { corrections: 9 }), ...sufficientWeek(LAST_WEEK, { corrections: 1 })], now: NOW });
  assert.equal(kpi(worse, 'correction-rate').trend, 'worse');
  assert.ok(worse.summary.some(line => line.startsWith('Worse than last week') && line.includes('more often')));
});

test('only interactive chats count, and chats belong to a week by startedAt', () => {
  const automated = many(20, { startedAt: THIS_WEEK, automated: true, corrections: [{ category: 'redo' }] });
  const report = buildReport({ metrics: [...sufficientWeek(THIS_WEEK), ...automated, ...sufficientWeek(OLDER)], now: NOW });
  assert.equal(report.coverage.chatsTotal, 40);
  assert.equal(report.coverage.chatsInteractive, 20);
  assert.equal(report.coverage.chatsInPeriod, 10);
  assert.equal(kpi(report, 'correction-rate').n, 10);
  assert.equal(report.corrections.total, 3);
  assert.equal(report.corrections.byCategory.find(c => c.category === 'redo'), undefined);
  assert.ok(report.missing.includes('No chats in the previous week: trends unavailable.'));
  assert.equal(report.coverage.firstChatAt, OLDER);
});

test('predictors: insufficient groups give null effect', () => {
  const metrics = [...many(9, { compactions: 2, startedAt: OLDER }), ...many(40, { startedAt: OLDER })];
  const report = buildReport({ metrics, now: NOW });
  const compacted = report.predictors.find(p => p.factor === 'compacted');
  assert.deepEqual([compacted.status, compacted.effect, compacted.ci95, compacted.nWith, compacted.nWithout, compacted.validated],
    ['insufficient', null, null, 9, 40, false]);
  // Effort null chats are excluded from both effort groups.
  const effort = buildReport({ metrics: [...many(12, { effort: 'low' }), ...many(12, { effort: null }), ...many(12, { effort: 'xhigh' })], now: NOW })
    .predictors.find(p => p.factor === 'low-effort');
  assert.deepEqual([effort.nWith, effort.nWithout], [12, 12]);
});

test('predictors: a strongly separated factor is validated and drives the experiment', () => {
  const problem = { corrections: [{ category: 'misunderstood' }] };
  const noSpec = many(30, i => ({ hasSpec: false, startedAt: OLDER, ...(i < 25 ? problem : {}) }));
  const spec = many(30, i => ({ hasSpec: true, startedAt: OLDER, ...(i < 3 ? problem : {}) }));
  const report = buildReport({ metrics: [...noSpec, ...spec], now: NOW, seed: 7 });
  const top = report.predictors[0];
  assert.equal(top.factor, 'no-spec');
  assert.equal(top.status, 'ok');
  assert.equal(top.validated, true);
  assert.ok(Math.abs(top.effect - (25 / 30 - 3 / 30) * 100) < 0.01);
  assert.ok(top.ci95[0] > 0 && top.ci95[1] >= top.effect && top.ci95[0] <= top.effect);
  assert.match(report.experiment.action, /agent-relay-spec/);
  assert.match(report.experiment.why, /percentage points/);
  assert.ok(report.summary.at(-1).includes('agent-relay-spec'));
  // Deterministic with a seed.
  const again = buildReport({ metrics: [...noSpec, ...spec], now: NOW, seed: 7 });
  assert.deepEqual(again.predictors, report.predictors);
  // model:<id> and task:<type> factors appear once a group has 10+ chats.
  const factors = report.predictors.map(p => p.factor);
  assert.ok(factors.includes('model:claude-opus-5-5') || report.predictors.length === 12);
  assert.ok(report.predictors.length <= 12);
});

test('predictor ranking: validated first, then absolute effect, insufficient last', () => {
  const row = (factor, effect, validated) => ({ factor, effect, validated, status: effect === null ? 'insufficient' : 'ok' });
  const ranked = rankPredictors([row('a', 30, false), row('b', null, false), row('c', -12, true), row('d', 5, true), row('e', -40, false)]);
  assert.deepEqual(ranked.map(r => r.factor), ['c', 'd', 'e', 'a', 'b']);
});

test('honest prose: insufficient weeks and no validated predictor', () => {
  const report = buildReport({ metrics: many(4, { startedAt: THIS_WEEK, userTurns: 1 }), now: NOW });
  assert.ok(report.summary.length >= 3 && report.summary.length <= 5);
  assert.ok(report.summary.some(line => line.includes('not enough data yet')));
  assert.ok(!report.summary.some(line => /^(Better|Worse) than last week/.test(line)));
  assert.match(report.experiment.action, /label-check/);
  assert.equal(report.experiment.title, 'Check the labels');
  assert.match(report.experiment.why, /No factor is a validated predictor/);
  assert.deepEqual(report.judge, { status: 'not-calibrated', labeled: 0, kappa: null, correlation: null, note: 'Needs about 100 labels from the owner before its scores are trusted.' });
  // An empty dataset still produces a valid, honest report.
  const empty = buildReport({ metrics: [], now: NOW });
  assert.match(empty.summary[0], /no interactive chats/);
  assert.ok(empty.missing.includes('No interactive chats in this period.'));
  assertValid('report', empty);
});

test('corrections: categories with plain labels, examples prefer the period', () => {
  const metrics = [
    chatMetrics({ startedAt: THIS_WEEK, corrections: [{ category: 'wrong-result', excerpt: 'this week: sigue fallando' }, { category: 'wrong-result', excerpt: 'this week: still broken' }, { category: 'scope', excerpt: 'this week: too much' }] }),
    chatMetrics({ startedAt: LAST_WEEK, corrections: [{ category: 'wrong-result', excerpt: 'older: wrong output' }, { category: 'incomplete', excerpt: 'older: falta el test' }] }),
  ];
  const { corrections } = buildReport({ metrics, now: NOW });
  assert.equal(corrections.total, 3);
  assert.deepEqual(corrections.byCategory.map(c => [c.category, c.label, c.count, c.previous]), [
    ['wrong-result', 'It did not work', 2, 1], ['scope', 'Did more or less than asked', 1, 0], ['incomplete', 'Something was missing', 0, 1],
  ]);
  const wrong = corrections.examples.filter(x => x.category === 'wrong-result').map(x => x.text);
  assert.deepEqual(wrong, ['this week: sigue fallando', 'this week: still broken']);
  assert.ok(corrections.examples.some(x => x.text === 'older: falta el test'));
  assert.ok(corrections.examples.every(x => x.text.length <= 160));
});

test('privacy: planted personal data, ids and paths never reach JSON or HTML', () => {
  const email = 'ana.synthetic@example.com', digits = '3001234567', winPath = 'C:\\Users\\example\\private\\notes.txt';
  const metrics = [
    ...sufficientWeek(THIS_WEEK),
    chatMetrics({ startedAt: THIS_WEEK, corrections: [{ category: 'process', excerpt: `mail ${email} or call ${digits} <script>alert(1)</script>` },
      { category: 'other', excerpt: `see ${winPath} and claude:synthetic-9999 /home/example/.codex/x.jsonl ${'y'.repeat(300)}` }] }),
  ];
  const retro = [{ dimension: 'project', value: `${FAKE_ROOT}/apps/demo`, chats: 12, correctionRate: 1, falseDoneRate: 0.1, fixRevertRate: 0, medianTurnsToVerifiedCommit: 2, insufficient: false }];
  const report = buildReport({ metrics, retro, missing: [`contact ${email}`], now: NOW });
  const json = JSON.stringify(report), html = renderReportHtml(report);
  for (const output of [json, html]) {
    for (const secret of [email, digits, 'Users\\example', 'Users/example', '/home/example', 'claude:synthetic', FAKE_ROOT]) {
      assert.ok(!output.includes(secret), 'a planted private value leaked into the output');
    }
  }
  assert.ok(json.includes('[REDACTED:email]') && json.includes('[REDACTED:number]') && json.includes('[REDACTED:path]'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(report.corrections.examples.every(x => x.text.length <= 160));
  assert.equal(report.models.rows[0].value, 'demo');
  assert.equal(redactLight('keep v2.4 and 2026-10-22'), 'keep v2.4 and 2026-10-22');
});

test('HTML: self-contained, KPIs before the first details, all details closed', () => {
  const report = buildReport({ metrics: [...sufficientWeek(THIS_WEEK, { corrections: 1 }), ...sufficientWeek(LAST_WEEK, { corrections: 9 })], now: NOW });
  const html = renderReportHtml(report);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.ok(!/<script|<link|<img|<iframe|\ssrc=|https?:\/\//i.test(html), 'the page must not load anything external or run scripts');
  const firstDetails = html.indexOf('<details');
  assert.ok(firstDetails > 0);
  for (const label of ['Corrections', 'Broken &quot;done&quot;', 'Verified commits', 'Fixed or reverted within 72 h']) {
    const at = html.indexOf(`<h3>${label}</h3>`);
    assert.ok(at > 0 && at < firstDetails, `${label} must appear before the first details section`);
  }
  assert.ok(html.indexOf("This week's experiment") < firstDetails);
  const summaryAt = html.indexOf('<ul class="summary">');
  assert.ok(summaryAt > 0 && summaryAt < html.indexOf('<div class="kpis">'), 'summary sentences come before the KPIs');
  assert.ok(html.includes('this week (Oct 19 – Oct 25, 2026)') || html.includes('This week (Oct 19 – Oct 25, 2026)'));
  const tags = html.match(/<details[^>]*>/g);
  assert.ok(tags.length >= 7);
  assert.ok(tags.every(tag => tag === '<details>'));
  assert.match(html, /▼ better than last week/);
  // Insufficient KPIs show the honest text instead of a number.
  const thin = renderReportHtml(buildReport({ metrics: many(3, { startedAt: THIS_WEEK }), now: NOW }));
  assert.ok((thin.match(/not enough data yet/g) ?? []).length >= 4);
  assert.match(thin, /not calibrated/);
});

test('writeReport writes atomically and refuses to overwrite a different report', () => {
  const dir = tempDir(), previous = process.env.RELAY_EVALS_REPORTS;
  try {
    process.env.RELAY_EVALS_REPORTS = dir;
    const report = buildReport({ metrics: sufficientWeek(THIS_WEEK), now: NOW, run: { durationMs: 1200, peakRssBytes: 1e8, trigger: 'manual' } });
    const out = writeReport({ report });
    assert.equal(out.dir, path.join(dir, '2026-10-25'));
    assert.deepEqual(fs.readdirSync(out.dir).sort(), ['report.html', 'report.json']);
    const saved = JSON.parse(fs.readFileSync(out.json, 'utf8'));
    assert.deepEqual(saved, report);
    assertValid('report', saved);
    assert.equal(fs.readFileSync(out.html, 'utf8'), renderReportHtml(report));
    // Same content again is fine; a different report needs replace.
    writeReport({ report, dir });
    const other = buildReport({ metrics: sufficientWeek(THIS_WEEK, { corrections: 5 }), now: NOW });
    assert.throws(() => writeReport({ report: other, dir, date: '2026-10-25' }), /already exists/);
    assert.deepEqual(JSON.parse(fs.readFileSync(out.json, 'utf8')), report);
    writeReport({ report: other, dir, date: '2026-10-25', replace: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(out.json, 'utf8')), other);
    assert.deepEqual(fs.readdirSync(out.dir).sort(), ['report.html', 'report.json'], 'no temp files are left behind');
    assert.throws(() => writeReport({ report: { ...report, kpis: [] }, dir }), /Invalid report/);
    assert.throws(() => writeReport({ report, dir, date: '../x' }), /YYYY-MM-DD/);
  } finally {
    if (previous === undefined) delete process.env.RELAY_EVALS_REPORTS; else process.env.RELAY_EVALS_REPORTS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark merges catalog counts with the provided estimate and runs', () => {
  const task = JSON.parse(fs.readFileSync(new URL('./fixtures/evals/task.sample.json', import.meta.url), 'utf8'));
  const tasks = [task, { ...task, id: 'task:1111111111111111', suite: { ...task.suite, split: 'holdout' } },
    { ...task, id: 'task:2222222222222222', excluded: true, excludedReason: 'automated lane', reproducible: false, suite: undefined }];
  const runs = [{ variant: 'baseline', tasks: 2, passedFirstTry: 1, medianTurns: 3, medianMinutes: 12, medianTokens: 9000, interventions: 0 }];
  const report = buildReport({ metrics: [], tasks: JSON.parse(JSON.stringify(tasks)), benchmark: { estimate: { turns: 40, days: 1.5, turnsPerDay: 32 }, runs }, now: NOW });
  assert.deepEqual(report.benchmark, { catalogTasks: 2, excludedTasks: 1, reproducibleTasks: 2, holdoutTasks: 1, estimate: { turns: 40, days: 1.5, turnsPerDay: 32 }, runs });
  assert.deepEqual(report.models, { scope: 'All interactive chats to date', rows: [] });
  assert.ok(report.methodology.length >= 14);
  for (const term of ['Correction', 'Broken done', 'Verified commit', 'Fix or revert within 72 h', 'Predictor', 'Percentage points', 'Confidence interval', 'Bootstrap', 'n', 'Kappa', 'Holdout', 'Effort', 'Spec', 'Compaction']) {
    assert.ok(report.methodology.some(m => m.term === term), `glossary lacks ${term}`);
  }
});

test('a trait that only goes with longer chats is not reported as a validated predictor', () => {
  // Long chats (20 messages) always have a correction, short ones (1 message) never; compaction appears mostly in long chats.
  const chat = (long, compacted) => chatMetrics({ startedAt: OLDER, userTurns: long ? 20 : 1, compactions: compacted ? 1 : 0,
    corrections: long ? [{ category: 'redo' }] : [] });
  const metrics = [...Array.from({ length: 40 }, (_, i) => chat(true, i < 35)), ...Array.from({ length: 40 }, (_, i) => chat(false, i < 5))];
  const report = buildReport({ metrics, now: NOW });
  const compacted = report.predictors.find(p => p.factor === 'compacted');
  assert.equal(compacted.effect, 0);
  assert.equal(compacted.validated, false);
});

test('predictors need 30 chats per side and 5 per length group', () => {
  const problem = { corrections: [{ category: 'misunderstood' }] };
  // 29 vs 29 with a huge effect is still insufficient.
  const small = buildReport({ metrics: [...many(29, { compactions: 1, startedAt: OLDER, ...problem }), ...many(29, { startedAt: OLDER })], now: NOW })
    .predictors.find(p => p.factor === 'compacted');
  assert.equal(small.status, 'insufficient');
  // Length groups with fewer than 5 chats on a side are left out, so 4 + 30 counts as 30.
  const mixed = [...many(30, { compactions: 1, startedAt: OLDER, ...problem }), ...many(4, { compactions: 1, userTurns: 20, startedAt: OLDER }),
    ...many(30, { startedAt: OLDER }), ...many(30, { userTurns: 20, startedAt: OLDER })];
  const row = buildReport({ metrics: mixed, now: NOW, seed: 3 }).predictors.find(p => p.factor === 'compacted');
  assert.equal(row.status, 'ok');
  assert.equal(row.effect, 100, 'only the length group with enough chats on both sides counts');
  assert.equal(row.validated, true);
});

test('"spec first" experiments are not proposed while spec chats have more problems', () => {
  const problem = { corrections: [{ category: 'misunderstood' }] };
  // Docs chats have many problems, and so do the chats WITH a spec.
  const metrics = [
    ...many(35, i => ({ taskType: 'docs', hasSpec: true, startedAt: OLDER, ...(i < 30 ? problem : {}) })),
    ...many(35, i => ({ taskType: 'feature', hasSpec: false, startedAt: OLDER, ...(i < 3 ? problem : {}) })),
  ];
  const report = buildReport({ metrics, now: NOW, seed: 5 });
  const docs = report.predictors.find(p => p.factor === 'task:docs');
  assert.equal(docs.validated, true);
  assert.ok(report.predictors.find(p => p.factor === 'no-spec').effect < 0);
  assert.equal(report.experiment.title, 'Check the labels');
});

test('labels: Claude and rule chats are counted and the label check passes through', () => {
  const metrics = [...many(3, { startedAt: THIS_WEEK, modelPass: { status: 'ok', model: 'claude-sonnet-5-5', added: 0 } }), ...many(2, { startedAt: THIS_WEEK })];
  const labelCheck = { total: 70, answered: 12, checkedBy: ['claude-opus-5-5'], kinds: [
    { kind: 'correction', label: 'Corrections', total: 50, answered: 10, confirmed: 9, rate: 90, ci95: [59.6, 98.2] },
    { kind: 'broken-done', label: 'Broken "done"', total: 20, answered: 2, confirmed: 1, rate: 50, ci95: null },
  ] };
  const report = assertValid('report', buildReport({ metrics, labelCheck, now: NOW }));
  assert.deepEqual([report.labels.model, report.labels.claudeChats, report.labels.ruleChats], ['claude-sonnet-5-5', 3, 2]);
  assert.deepEqual(report.labels.check.kinds[0], labelCheck.kinds[0]);
  assert.deepEqual(report.labels.check.checkedBy, ['claude-opus-5-5']);
  assert.ok(report.missing.some(note => /2 interactive chats are not fully labeled/.test(note)));
  const html = renderReportHtml(report);
  assert.match(html, /Claude \(claude-sonnet-5-5\) labeled corrections/);
  assert.match(html, /Checked by claude-opus-5-5 \(a model review, not a human check\)/);
  assert.match(html, /Corrections: 9 of 10 confirmed \(90%, 95% CI 59.6–98.2%\)/);
  assert.equal(buildReport({ metrics, now: NOW }).labels.check, null);

  // Codex labels and a check that names whose labels it sampled.
  const codex = metrics.map(m => (m.modelPass ? { ...m, modelPass: { ...m.modelPass, model: 'gpt-6.1-sol' } } : m));
  const withCodex = assertValid('report', buildReport({ metrics: codex, labelCheck: { ...labelCheck, labeledBy: ['gpt-6.1-sol'] }, now: NOW }));
  assert.deepEqual(withCodex.labels.check.labeledBy, ['gpt-6.1-sol']);
  const codexHtml = renderReportHtml(withCodex);
  assert.match(codexHtml, /Codex \(gpt-6\.1-sol\) labeled corrections/);
  assert.match(codexHtml, /Labels by gpt-6\.1-sol, checked by claude-opus-5-5/);
});
