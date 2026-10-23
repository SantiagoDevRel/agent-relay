// Read-only access to the newest weekly Relay Evals report for the Evals page.
// Runs only on request (GET /api/evals/latest): never inside the collection loop,
// the SSE snapshot or startup. Responses carry the report or a short reason code,
// never a stack trace or a filesystem path. POST /api/evals/analyze opens one
// clicked analysis chat; nothing here runs on a timer.
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { reportsDir } from '../evals/store.mjs';
import { validate } from '../evals/schema.mjs';

export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const DATE_FOLDER = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(name) {
  const match = DATE_FOLDER.exec(name);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === name;
}

// Reads one <dir>/<date>/report.json. A folder without the file (for example a
// run still in progress) is 'missing'; symlinks/junctions (folder or file),
// oversized files, unreadable JSON and schema violations are 'invalid'.
async function readCandidate(dir, date) {
  const folder = path.join(dir, date), file = path.join(folder, 'report.json');
  let stat;
  try {
    if (!(await fs.lstat(folder)).isDirectory()) return { status: 'missing' };
    stat = await fs.lstat(file);
  } catch { return { status: 'missing' }; }
  try {
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return { status: 'invalid' };
    const handle = await fs.open(file, 'r');
    let text;
    try {
      // One byte more than allowed detects a file that grew after lstat.
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_REPORT_BYTES) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_REPORT_BYTES) return { status: 'invalid' };
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
    const report = JSON.parse(text);
    return validate('report', report).length ? { status: 'invalid' } : { status: 'ok', report };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Newest valid report under `<dir>/<YYYY-MM-DD>/report.json`.
 * @returns {Promise<{ report: object, generatedAt: string, date: string } | { report: null, reason: 'no-report' | 'invalid-report' }>}
 */
export async function latestReport({ dir = reportsDir() } = {}) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return { report: null, reason: 'no-report' }; }
  const dates = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isCalendarDate(entry.name))
    .map(entry => entry.name).sort().reverse();
  let invalid = false;
  for (const date of dates) {
    const candidate = await readCandidate(dir, date);
    if (candidate.status === 'ok') return { report: candidate.report, generatedAt: candidate.report.generatedAt, date };
    if (candidate.status === 'invalid') invalid = true;
  }
  return { report: null, reason: invalid ? 'invalid-report' : 'no-report' };
}

const ANALYSIS_REPEAT_MS = 30_000;
const recentAnalyses = new Map();

/**
 * Opens one interactive Claude or Codex analysis chat for the newest valid report (POST /api/evals/analyze).
 * The client names an analysis ID and a provider ID only; the model, prompt and paths are chosen here.
 * A repeated click on the same analysis and provider within 30 s is refused so a double click cannot open two chats.
 */
export async function startAnalysis(id, { provider = 'claude', launch, dir = reportsDir(), env = process.env, now = Date.now } = {}) {
  const { analysisById, analysisPrompt, analysisProvider } = await import('../evals/analysis.mjs');
  if (typeof id !== 'string' || !analysisById(id)) throw Object.assign(Error('Unknown analysis.'), { status: 400 });
  const agent = typeof provider === 'string' ? analysisProvider(provider) : null;
  if (!agent) throw Object.assign(Error('Unknown provider.'), { status: 400 });
  const latest = await latestReport({ dir });
  if (!latest.report) throw Object.assign(Error('No valid weekly report to analyze yet.'), { status: 409 });
  const key = `${agent.id}:${id}`, at = now(), last = recentAnalyses.get(key);
  if (last !== undefined && at - last < ANALYSIS_REPEAT_MS) throw Object.assign(Error('This analysis just opened. Check the Relay Evals terminal window.'), { status: 409 });
  recentAnalyses.set(key, at);
  try {
    await launch({ prompt: analysisPrompt(id, latest, { env: { ...env, RELAY_EVALS_REPORTS: dir } }), provider: agent.id, model: agent.model });
  } catch (error) { recentAnalyses.delete(key); throw error; }
  return { opened: true, id, provider: agent.id, model: agent.model, date: latest.date };
}
