// E6 weekly report as one self-contained HTML page: inline CSS, no scripts and no
// external requests. Readable at 390 px; follows the system light/dark preference.
// Every interpolated value goes through escapeHtml.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
const e = escapeHtml;

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1d1f;--muted:#5d5d63;--line:#dedcd6;--good:#1f7a55;--bad:#b3261e;--gold:#8a6400;--accent:#5b4bb7}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c20;--text:#ecebe8;--muted:#a3a2a8;--line:#2e2e34;--good:#4cc38a;--bad:#ff7a70;--gold:#e0b44c;--accent:#a99bff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:28px 0 10px}
.period{color:var(--muted);margin:0 0 16px}
.summary{padding-left:20px;margin:0 0 8px}.summary li{margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi h3{font-size:.95rem;margin:0 0 4px}.kpi .value{font-size:1.5rem;font-weight:650}
.kpi .trend{font-size:.9rem;margin:2px 0}.kpi .meaning,.small{font-size:.85rem;color:var(--muted);margin:4px 0 0}
.better{color:var(--good)}.worse{color:var(--bad)}.same,.unknown{color:var(--muted)}.nodata{color:var(--gold);font-weight:600}
.experiment{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:12px 14px}
.experiment p{margin:6px 0}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:0 14px}
summary{cursor:pointer;font-weight:600;padding:12px 0}
details>div{padding:0 0 12px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--line);color:var(--muted);overflow-wrap:anywhere}
dt{font-weight:600;margin-top:8px}dd{margin:2px 0 0}
`;

const UNIT = { per10: v => `${v} per 10 messages`, percent: v => `${v}%`, count: v => `${v}`, turns: v => `${v} turns` };
const fmt = (kpi, v) => (v === null || v === undefined ? '—' : (UNIT[kpi.unit] ?? String)(v));
const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
const num = v => (v === null || v === undefined ? '—' : String(Math.round(v * 10) / 10));

// The arrow shows the direction the number moved; the word says whether that is good.
function trendLine(kpi) {
  if (kpi.insufficient) return '<p class="trend nodata">not enough data yet</p>';
  if (kpi.trend === 'unknown') return '<p class="trend unknown">no comparison with last week</p>';
  if (kpi.trend === 'same') return `<p class="trend same">no clear change from last week (${e(fmt(kpi, kpi.previous))})</p>`;
  const wentDown = (kpi.trend === 'better') === (kpi.goodDirection === 'down');
  return `<p class="trend ${e(kpi.trend)}">${wentDown ? '▼' : '▲'} ${e(kpi.trend)} than last week (${e(fmt(kpi, kpi.previous))})</p>`;
}

function kpiCard(kpi) {
  const value = kpi.insufficient || kpi.value === null ? '<span class="nodata">not enough data yet</span>' : e(fmt(kpi, kpi.value));
  return `<section class="kpi"><h3>${e(kpi.label)}</h3><div class="value">${value}</div>${trendLine(kpi)}`
    + `<p class="meaning">${e(kpi.meaning)} (n = ${e(kpi.n)})</p></section>`;
}

const section = (title, body) => `<details><summary>${e(title)}</summary><div>${body}</div></details>`;
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead>`
  + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

function predictorsSection(report) {
  const top = report.predictors.slice(0, 3);
  if (!top.length) return section('What predicts problems', '<p>No factors could be compared yet.</p>');
  const items = top.map(p => {
    const detail = p.status === 'ok'
      ? `${p.effect > 0 ? '+' : ''}${p.effect} percentage points (95% CI ${p.ci95[0]} to ${p.ci95[1]}; n = ${p.nWith} with, ${p.nWithout} without)${p.validated ? ' — validated' : ' — not validated: the interval includes zero'}`
      : `insufficient data (n = ${p.nWith} with, ${p.nWithout} without; at least 10 each are needed)`;
    return `<li><strong>${e(p.label)}</strong>: ${e(detail)}</li>`;
  }).join('');
  return section('What predicts problems (top 3)',
    `<p class="small">Outcome: ${e(top[0].outcome)}. Effect = problem rate with the factor minus without it.</p><ol>${items}</ol>`);
}

function correctionsSection(c) {
  const rows = c.byCategory.map(r => [r.label, r.count, r.previous]);
  const body = [`<p>${e(c.total)} correction${c.total === 1 ? '' : 's'} this week.</p>`,
    rows.length ? table(['Category', 'This week', 'Last week'], rows) : '<p>No corrections recorded.</p>'];
  if (c.examples.length) {
    const labels = Object.fromEntries(c.byCategory.map(r => [r.category, r.label]));
    body.push('<h3 class="small">Short redacted examples</h3>', ...c.examples.map(x => `<blockquote>${e(x.text)}<br><span class="small">${e(labels[x.category] ?? x.category)}</span></blockquote>`));
  }
  return section('Corrections by category', body.join(''));
}

function modelsSection(m) {
  if (!m.rows.length) return section('Models and settings', `<p>${e(m.scope)}: no rows yet.</p>`);
  const rows = m.rows.map(r => [r.dimension, r.value, r.chats, r.insufficient ? 'not enough data' : num(r.correctionRate),
    r.insufficient ? '—' : pct(r.falseDoneRate), r.insufficient ? '—' : pct(r.fixRevertRate), num(r.medianTurnsToVerifiedCommit)]);
  return section('Models and settings', `<p class="small">${e(m.scope)}.</p>`
    + table(['Dimension', 'Value', 'Chats', 'Corrections per 10', 'Broken done', 'Fixed in 72 h', 'Turns to verified commit'], rows));
}

function benchmarkSection(b) {
  const parts = [`<p>${e(b.catalogTasks)} catalog tasks, ${e(b.excludedTasks)} excluded, ${e(b.reproducibleTasks)} reproducible, ${e(b.holdoutTasks)} in the holdout.</p>`];
  parts.push(b.estimate ? `<p>Running the suite would take about ${e(b.estimate.turns)} turns, ${e(b.estimate.days)} days at ${e(b.estimate.turnsPerDay)} turns per day.</p>`
    : '<p>No run estimate yet.</p>');
  parts.push(b.runs.length ? table(['Variant', 'Tasks', 'Passed first try', 'Median turns', 'Median minutes', 'Median tokens', 'Interventions'],
    b.runs.map(r => [r.variant, r.tasks, r.passedFirstTry, num(r.medianTurns), num(r.medianMinutes), num(r.medianTokens), r.interventions]))
    : '<p>No benchmark runs yet.</p>');
  return section('Benchmark', parts.join(''));
}

// Labels come from Claude or Codex; the model ID says which.
const labelerName = model => !model ? 'A model (unknown)' : `${/^claude/i.test(model) ? 'Claude' : 'Codex'} (${model})`;

function labelsSection(l) {
  if (!l) return '';
  const chats = l.claudeChats + l.ruleChats;
  const who = l.claudeChats ? `<p>${e(labelerName(l.model))} labeled corrections and broken “done” claims in ${e(l.claudeChats)} of ${e(chats)} chats${l.ruleChats ? '; the rest use fixed text rules' : ''}.</p>` : `<p>Corrections come from fixed text rules in all ${e(chats)} chats.</p>`;
  const kinds = (l.check?.kinds ?? []).filter(k => k.answered);
  const by = l.check?.checkedBy?.length ? `<p class="small">${l.check.labeledBy?.length ? `Labels by ${e(l.check.labeledBy.join(', '))}, checked` : 'Checked'} by ${e(l.check.checkedBy.join(', '))}${l.check.checkedBy.some(name => name !== 'owner') ? ' (a model review, not a human check)' : ''}.</p>` : '';
  const check = kinds.length ? by + `<ul>${kinds.map(k => `<li>${e(k.label)}: ${e(k.confirmed)} of ${e(k.answered)} confirmed (${e(k.rate)}%${k.ci95 ? `, 95% CI ${e(k.ci95[0])}–${e(k.ci95[1])}%` : ''})</li>`).join('')}</ul>`
    : '<p class="small">No answered label check yet (node evals/cli.mjs label-check).</p>';
  return section('Who labeled the corrections', who + check);
}

function judgeSection(j) {
  const status = j.status === 'calibrated' ? 'calibrated' : 'not calibrated';
  const parts = [`<p>The spec judge is <strong>${e(status)}</strong> (${e(j.labeled)} labels).</p>`, `<p>${e(j.note)}</p>`];
  if (j.kappa !== null) parts.push(`<p>Kappa: ${e(Math.round(j.kappa * 100) / 100)}</p>`);
  if (j.correlation) parts.push(`<p>Correlation with ${e(j.correlation.outcome)}: ${e(j.correlation.r)} (95% CI ${e(j.correlation.ci95[0])} to ${e(j.correlation.ci95[1])}; n = ${e(j.correlation.n)})</p>`);
  return section('Spec judge', parts.join(''));
}

export function renderReportHtml(report) {
  const r = report;
  const coverage = `${r.coverage.chatsInPeriod} chats this week · ${r.coverage.chatsInteractive} interactive chats in total`;
  const x = r.experiment;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${e(`Relay Evals weekly report · ${r.period.label}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Relay Evals weekly report</h1>
<p class="period">${e(r.period.label)} · ${e(coverage)}</p>
<ul class="summary">${r.summary.map(s => `<li>${e(s)}</li>`).join('')}</ul>
<div class="kpis">${r.kpis.map(kpiCard).join('')}</div>
<h2>This week's experiment</h2>
<section class="experiment"><p><strong>${e(x.title)}</strong></p><p>${e(x.action)}</p><p class="small">Why: ${e(x.why)}</p><p class="small">How to measure: ${e(x.measure)}</p></section>
<h2>Details</h2>
${predictorsSection(r)}
${correctionsSection(r.corrections)}
${modelsSection(r.models)}
${benchmarkSection(r.benchmark)}
${labelsSection(r.labels)}
${judgeSection(r.judge)}
${section('How to read this report', `<dl>${r.methodology.map(m => `<dt>${e(m.term)}</dt><dd>${e(m.explanation)}</dd>`).join('')}</dl>`)}
${section('Missing parts', r.missing.length ? `<ul>${r.missing.map(m => `<li>${e(m)}</li>`).join('')}</ul>` : '<p>Nothing is missing.</p>')}
<p class="small">Generated ${e(r.generatedAt)}. Aggregates and short redacted examples only.</p>
</main>
</body>
</html>
`;
}
