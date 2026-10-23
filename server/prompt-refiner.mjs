import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMissionRunner, readOnlyInspection } from './mission-runner.mjs';
import { projectKey } from './claude.mjs';
import { jsonLines } from './util.mjs';

const skill = fileURLToPath(new URL('../skills/agent-relay-spec/SKILL.md', import.meta.url));
export const REFINEMENT_TIMEOUT_MS = 15 * 60000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HANDLE = /^(?:claude|codex)-[a-f0-9]{6}$/;
const LOG_LIMIT = 128 * 1024, HISTORY_LIMIT = 100;
const NATIVE_LIMIT = 1024 * 1024, NATIVE_CACHE_MS = 30000;
const plain = value => String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const metadataError = (message, status) => Object.assign(Error(message), { status });
const nativeBudget = () => ({ deadline: Date.now() + 100, bytes: 4 * NATIVE_LIMIT, files: 32 });
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function safeDirectory(root, segments = []) {
  if (!path.isAbsolute(root)) return null;
  let current = root;
  for (const segment of [null, ...segments]) {
    if (segment !== null) current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  }
  return path.relative(fs.realpathSync(root), fs.realpathSync(current)) === (segments.length ? path.join(...segments) : '') ? current : null;
}
function safeFile(directory, name) {
  const file = path.join(directory, name), stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && path.relative(fs.realpathSync(directory), fs.realpathSync(file)) === name ? { file, stat } : null;
}
function boundedFile(source, limit, budget) {
  if (!source || source.stat.size > limit || source.stat.size > budget.bytes || budget.files <= 0 || Date.now() >= budget.deadline) return null;
  budget.files--; budget.bytes -= source.stat.size;
  const fd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (signature(opened) !== signature(source.stat)) return null;
    const data = Buffer.alloc(opened.size);
    if (fs.readSync(fd, data, 0, data.length, 0) !== data.length) return null;
    if (signature(fs.fstatSync(fd)) !== signature(opened)) return null;
    return data.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function turnDiagnostic(result) {
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  if (result.timedOut) return { code: 'timeout', exitCode, timedOut: true, reason: 'The specification reached its 15-minute operation limit. Your request and output are saved; review the log before retrying.' };
  if (result.aborted) return { code: 'canceled', exitCode, aborted: true, reason: 'Specification preparation was canceled. Your request and output are saved; no retry was started.' };
  if (exitCode !== 0) return { code: 'provider-failed', exitCode, reason: `The provider exited with code ${exitCode ?? 'unknown'} before completing the specification. Review its saved output before retrying.`, ...(result.error ? { error: plain(result.error).slice(-2000) } : {}) };
  if (!result.answer) return { code: 'empty-answer', exitCode, reason: 'The provider finished without a captured specification. Your request and output are saved; review the log before retrying.' };
  return { code: 'completed', exitCode, reason: 'The provider completed its turn. The saved response is checked before the specification can be adopted.' };
}
// 'lab' is the standalone Prompt Lab page: the user copies the improved prompt instead of applying it to a form.
const KINDS = ['mission', 'relay', 'lab'];
const LAB_NOTE = 'Kind lab: the user will paste the improved goal into another agent chat, so make it a complete, self-contained prompt for that agent.\n';
const fail = message => Object.assign(Error(message), { status: 422 });
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
function list(value, max = 30) { return Array.isArray(value) && value.length <= max && value.every(item => text(item, 2000)); }

export function validatePromptSpec(raw, original, kind) {
  if (!raw || typeof raw !== 'object' || !['ready', 'needs_input'].includes(raw.status) || !text(raw.goal, 15000)
    || !text(raw.acceptance, 15000) || !Array.isArray(raw.requirements) || !raw.requirements.length || raw.requirements.length > 60
    || !list(raw.assumptions) || !list(raw.questions) || !list(raw.verification) || !raw.verification.length) throw fail('The AI did not return a complete, valid specification. Its response has been saved.');
  const ids = new Set(), source = original.goal + '\n' + original.acceptance;
  for (const item of raw.requirements) {
    if (!item || !text(item.id, 40) || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id) || !text(item.literal, 4000)
      || !source.includes(item.literal) || !text(item.criterion, 2000)) throw fail('The specification lost traceability to the literal requests. Read the saved response.');
    ids.add(item.id);
  }
  if ((raw.status === 'ready' && raw.questions.length) || (raw.status === 'needs_input' && !raw.questions.length)) throw fail('The specification status and questions do not match.');
  // Keep the complete original request in the adopted implementation prompt.
  let goal = `Original request (all requirements remain in scope):\n${original.goal}\n\n${kind === 'lab' ? 'Improved prompt' : 'Implementation specification'}:\n${raw.goal}`;
  const acceptance = `${original.acceptance ? `Original criteria:\n${original.acceptance}\n\n` : ''}${raw.acceptance}\n\nVerification:\n${raw.verification.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
  if (kind !== 'relay') goal += `\n\nAcceptance criteria:\n${acceptance}`;
  if (goal.length > (kind === 'relay' ? 4000 : 20000) || acceptance.length > (kind === 'relay' ? 6000 : 20000)) throw fail('The specification exceeds the allowed size. The request and response are saved; shorten the text without removing requirements.');
  return { status: raw.status, spec: { goal, acceptance, requirements: raw.requirements, assumptions: raw.assumptions, questions: raw.questions, verification: raw.verification } };
}

export class PromptRefiner {
  constructor({ file, artifacts, runner = createMissionRunner(), cwd = process.cwd(), home = os.homedir(), onChange = () => {} }) {
    this.file = file; this.artifacts = artifacts; this.runner = runner; this.cwd = cwd; this.home = home; this.onChange = onChange;
    this.nativeCache = new Map(); this.nativeDirectories = new Map();
    this.busy = false; this.controller = null;
    this.records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(this.records)) throw Error('Invalid prompt refinement state');
    for (const record of this.records) if (record.status === 'refining') { record.status = 'attention'; record.detail = 'The server restarted. The request is saved; another turn will not start automatically.'; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.records, null, 2)); fs.renameSync(temp, this.file); this.onChange();
  }
  attempt(id) {
    const record = UUID.test(id || '') && this.records.find(item => item.id === id);
    if (!record) throw metadataError('Prompt refinement attempt not found.', 404);
    return record;
  }
  nativeDiagnostic(record, budget) {
    const context = record.context || record.cwd;
    if (record.provider !== 'claude' || !UUID.test(record.id || '') || !path.isAbsolute(context || '') || !Number.isFinite(record.createdAt)
      || (!/^claude-[a-f0-9]{6}$/.test(record.sessionHandle || '') && !UUID.test(record.nativeId || '')) || Date.now() >= budget.deadline) return null;
    try {
      const owned = safeDirectory(this.artifacts, [record.id]), directory = safeDirectory(this.home, ['.claude', 'projects', projectKey(context)]);
      if (!owned || !directory) return null;
      const promptSource = safeFile(owned, 'spec-prompt.md');
      if (!promptSource) return null;
      const directorySignature = signature(fs.lstatSync(directory)), promptSignature = signature(promptSource.stat);
      const key = `${context}:${record.createdAt}:${record.nativeId || ''}:${directorySignature}:${promptSignature}`;
      const cached = this.nativeCache.get(record.id);
      if (cached?.key === key && Date.now() - cached.at < NATIVE_CACHE_MS) {
        if (!cached.source || signature(safeFile(directory, cached.source)?.stat || {}) === cached.signature) return cached.diagnostic;
      }
      const prompt = boundedFile(promptSource, LOG_LIMIT, budget);
      if (!prompt || Date.now() >= budget.deadline) return null;
      let candidates;
      if (UUID.test(record.nativeId || '')) candidates = [record.nativeId + '.jsonl'];
      else {
        const index = this.nativeDirectories.get(directory);
        if (index?.signature === directorySignature && Date.now() - index.at < NATIVE_CACHE_MS) candidates = index.names;
        else {
          candidates = []; const handle = fs.opendirSync(directory); let count = 0, entry;
          try {
            while ((entry = handle.readSync())) {
              if (++count > 512 || Date.now() >= budget.deadline) return null;
              if (entry.isFile() && UUID.test(entry.name.replace(/\.jsonl$/, '')) && entry.name.endsWith('.jsonl')) candidates.push(entry.name);
            }
          } finally { handle.closeSync(); }
          if (this.nativeDirectories.size >= HISTORY_LIMIT) this.nativeDirectories.delete(this.nativeDirectories.keys().next().value);
          this.nativeDirectories.set(directory, { at: Date.now(), signature: directorySignature, names: candidates });
        }
      }
      const matches = [], maximum = record.createdAt + REFINEMENT_TIMEOUT_MS + 120000;
      for (const name of candidates) {
        if (Date.now() >= budget.deadline || budget.files <= 0) return null;
        const source = safeFile(directory, name);
        if (!source || source.stat.birthtimeMs < record.createdAt - 5000 || source.stat.birthtimeMs > record.createdAt + 120000) continue;
        const contents = boundedFile(source, NATIVE_LIMIT, budget);
        if (contents === null) return null; // Incomplete coverage cannot establish a unique match.
        const events = [...jsonLines(contents)], users = events.filter(event => event.type === 'user');
        if (!contents.endsWith('\n') || events.length !== contents.split('\n').filter(line => line.trim()).length) return null;
        if (!users.length) continue;
        const user = users[0], content = typeof user.message?.content === 'string' ? user.message.content : Array.isArray(user.message?.content) ? user.message.content.filter(item => item.type === 'text').map(item => item.text || '').join('') : '';
        const normalized = content.replace(/\r\n/g, '\n'), saved = prompt.replace(/\r\n/g, '\n'), nativeId = name.slice(0, -6), started = Date.parse(user.timestamp);
        if (user.isSidechain || user.sessionId !== nativeId || path.resolve(user.cwd || '') !== path.resolve(context) || started < record.createdAt - 5000 || started > record.createdAt + 120000 || !Number.isFinite(started)) continue;
        if (normalized !== saved && !(normalized.startsWith('# === Reglas activas: ') && normalized.endsWith('\n\n---\n\n' + saved))) continue;
        matches.push({ name, source, nativeId, started, events, eligible: users.length === 1 && !events.some(event => event.type === 'assistant') });
      }
      let diagnostic = null, matched;
      if (matches.length === 1 && matches[0].eligible) {
        matched = matches[0];
        const event = matched.events.findLast(event => event.type === 'system' && event.subtype === 'api_error' && event.sessionId === matched.nativeId && path.resolve(event.cwd || '') === path.resolve(context) && Date.parse(event.timestamp) >= matched.started && Date.parse(event.timestamp) <= maximum);
        if (event) {
          const message = typeof event.error === 'string' ? event.error : event.error?.message;
          const reason = /^Connection error\.?$/i.test(message || '') ? 'Connection error.' : /^Request timed out\.?$/i.test(message || '') ? 'Request timed out.' : 'An API error occurred.';
          diagnostic = { code: 'provider-api-error', source: 'claude-native', nativeId: matched.nativeId, timestamp: event.timestamp, reason: `Claude reported: ${reason}` };
        }
      }
      if (this.nativeCache.size >= HISTORY_LIMIT) this.nativeCache.delete(this.nativeCache.keys().next().value);
      this.nativeCache.set(record.id, { at: Date.now(), key, diagnostic, ...(matched ? { source: matched.name, signature: signature(matched.source.stat) } : {}) });
      return diagnostic;
    } catch { return null; } // Linked, missing or unreadable provider data is never followed or guessed.
  }
  diagnostic(record, budget = nativeBudget()) {
    const saved = record.diagnostic;
    if (record.status === 'attention' && (!saved || ['unknown', 'empty-answer', 'timeout', 'runner-error'].includes(saved.code))) {
      const recovered = this.nativeDiagnostic(record, budget);
      if (recovered) return saved && saved.code !== 'unknown' ? { ...saved, source: recovered.source, nativeId: recovered.nativeId, timestamp: recovered.timestamp, reason: saved.reason.includes(recovered.reason) ? saved.reason : `${saved.reason} ${recovered.reason}` } : recovered;
    }
    return saved || (record.status === 'attention' ? { code: 'unknown', reason: 'No exit diagnostics saved for this older attempt. Review the available output; timeout or provider failure cannot be confirmed from this record.' } : undefined);
  }
  history(kind) {
    if (kind !== undefined && !KINDS.includes(kind)) throw metadataError('Select mission, relay or lab refinement history.', 400);
    const records = this.records.filter(record => UUID.test(record.id || '') && (!kind || record.kind === kind));
    const budget = nativeBudget();
    const attempts = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, HISTORY_LIMIT).map(record => ({
      id: record.id, kind: record.kind, status: record.status, provider: record.provider, model: record.model, effort: record.effort, createdAt: record.createdAt,
      ...(record.detail ? { detail: plain(record.detail).slice(0, 2000) } : {}), ...((diagnostic => diagnostic ? { diagnostic } : {})(this.diagnostic(record, budget))),
    }));
    return { attempts, total: records.length };
  }
  log(id) {
    const record = this.attempt(id), directory = path.join(this.artifacts, id), file = path.join(directory, 'spec-output.txt'), diagnostic = this.diagnostic(record);
    let text = '', truncated = false, fd;
    try {
      if (fs.existsSync(directory)) {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw metadataError('The saved refinement directory is linked or invalid. Its content was not opened.', 409);
        const root = fs.realpathSync(this.artifacts), actual = fs.realpathSync(directory);
        if (path.relative(root, actual) !== id) throw metadataError('The saved refinement directory is outside its owned artifact root.', 409);
        if (fs.existsSync(file)) {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || path.relative(actual, fs.realpathSync(file)) !== 'spec-output.txt') throw metadataError('The saved refinement log is linked or invalid. Its content was not opened.', 409);
          fd = fs.openSync(file, 'r'); const opened = fs.fstatSync(fd), size = opened.size;
          if (!opened.isFile() || opened.ino !== stat.ino) throw metadataError('The saved refinement log changed while it was opened.', 409);
          const bytes = Buffer.alloc(Math.min(size, LOG_LIMIT)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
          text = plain(bytes.toString('utf8')); truncated = size > LOG_LIMIT;
        }
      }
    } finally { if (fd != null) fs.closeSync(fd); }
    const detail = diagnostic?.reason || record.detail;
    if (detail && !text.includes(detail)) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n[Agent Relay diagnostic] ${detail}\n`;
    if (!text) text = 'No provider output has been saved yet. Viewing this log does not start a model turn.';
    if (text.length > LOG_LIMIT) { text = text.slice(-LOG_LIMIT); truncated = true; }
    const original = record.original && typeof record.original.goal === 'string' && record.original.goal.length <= 20000
      ? { goal: record.original.goal, acceptance: typeof record.original.acceptance === 'string' ? record.original.acceptance.slice(0, 20000) : '' } : undefined;
    return { text, truncated, ...(diagnostic ? { diagnostic } : {}), ...(original ? { original } : {}), ...(record.context ? { context: record.context } : {}) };
  }
  async refine(input) {
    if (this.busy) throw Object.assign(Error('A specification is already being prepared.'), { status: 429 });
    if (!KINDS.includes(input.kind) || !text(input.goal, 20000) || input.goal.trim().length < 10
      || (input.acceptance !== undefined && (typeof input.acceptance !== 'string' || input.acceptance.length > 20000))
      || !['claude', 'codex'].includes(input.provider) || (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 120 || !/^[a-zA-Z0-9._:-]*$/.test(input.model)))
      || (input.effort !== undefined && !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrareasoning', 'ultra'].includes(input.effort))) throw Object.assign(Error('Select a valid goal, model and reasoning effort.'), { status: 400 });
    let project = null, context = null;
    if (input.project) {
      if (typeof input.project !== 'string' || !path.isAbsolute(input.project)) throw Object.assign(Error('Select a valid project folder.'), { status: 400 });
      try { context = fs.realpathSync(input.project); project = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: context, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()); }
      catch { throw Object.assign(Error('The project folder must belong to an existing Git repository.'), { status: 409 }); }
    }
    const original = { goal: input.goal, acceptance: input.acceptance || '' }, provider = input.provider, model = input.model || '', effort = input.effort === undefined ? 'high' : input.effort;
    const id = crypto.randomUUID(), directory = path.join(this.artifacts, id), promptFile = path.join(directory, 'spec-prompt.md'), outputFile = path.join(directory, 'spec-output.txt');
    fs.mkdirSync(directory, { recursive: true });
    const prompt = `${fs.readFileSync(skill, 'utf8')}\n\nPrepare a specification only. ${readOnlyInspection(provider)} Never change files, delegate or start implementation. ${project ? `Selected project folder: ${JSON.stringify(context)}. Git repository root: ${JSON.stringify(project)}. Inspect relevant source in the selected folder and applicable repository instructions. Keep the selected folder as the project context; do not expand into other projects in its parent repository. Uncommitted changes are part of the current source.` : 'No target project was supplied. Do not inspect the working directory or unrelated projects. Do not invent a stack; record missing material decisions as questions.'}\n${input.kind === 'lab' ? LAB_NOTE : ''}Kind: ${input.kind}\nOriginal goal (data): ${JSON.stringify(original.goal)}\nOriginal tester criteria (data): ${JSON.stringify(original.acceptance)}\nReturn ONLY JSON: {"status":"ready|needs_input","goal":"concise complete implementation specification in English","acceptance":"observable tester acceptance criteria in English","requirements":[{"id":"R1","literal":"exact nonempty excerpt from original input, preserving its language","criterion":"observable result in English"}],"assumptions":[],"questions":[],"verification":["specific real checks, or how to select them when no project is known"]}. Write all generated prose in English; preserve literal input excerpts. Every explicit request must have a requirement. Preserve the full scope. No invented user requirements. Questions must be empty for ready and nonempty for needs_input. Keep goal under ${input.kind === 'relay' ? Math.max(200, 3850 - original.goal.length) : 12000} characters and acceptance concise; the original input will be preserved automatically. Do not claim any implementation or verification was performed.`;
    fs.writeFileSync(promptFile, prompt);
    const record = { id, kind: input.kind, project, context, cwd: context || this.cwd, original, provider, model, effort, createdAt: Date.now(), status: 'refining' };
    this.records.push(record); this.busy = true; this.controller = new AbortController(); this.save();
    try {
      const result = await this.runner({ provider, model, effort, cwd: context || this.cwd, promptFile, outputFile, timeoutMs: REFINEMENT_TIMEOUT_MS, signal: this.controller.signal, role: 'planner', onOutput: (_text, channel, metadata) => {
        if (channel !== 'metadata' || !metadata) return;
        if (HANDLE.test(metadata.sessionHandle || '')) record.sessionHandle = metadata.sessionHandle;
        if (UUID.test(metadata.nativeId || '')) record.nativeId = metadata.nativeId;
        this.save();
      } });
      if (result.sessionHandle) record.sessionHandle = result.sessionHandle;
      if (result.nativeId) record.nativeId = result.nativeId;
      record.diagnostic = { ...turnDiagnostic(result), completedAt: Date.now(), elapsedMs: Date.now() - record.createdAt };
      if (result.timedOut || result.aborted || result.exitCode !== 0 || !result.answer) throw fail(record.diagnostic.reason);
      let raw;
      try { raw = JSON.parse(result.answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw fail('The model did not return valid JSON. The response and your request have been saved.'); }
      const validated = validatePromptSpec(raw, original, input.kind);
      Object.assign(record, validated); this.save();
      return { id, ...validated, provider, model, effort };
    } catch (error) {
      record.status = 'attention'; record.detail = error.message;
      if (!record.diagnostic) record.diagnostic = { code: 'runner-error', reason: plain(error.message).slice(0, 2000), completedAt: Date.now(), elapsedMs: Date.now() - record.createdAt };
      else if (record.diagnostic.code === 'completed') record.diagnostic = { ...record.diagnostic, code: 'response-invalid', reason: plain(error.message).slice(0, 2000) };
      record.diagnostic = this.diagnostic(record); record.detail = record.diagnostic.reason; error.message = record.detail;
      const diagnosticText = `\n[Agent Relay diagnostic] ${record.diagnostic.reason}\n`;
      try { if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 8 * 1024 * 1024) fs.appendFileSync(outputFile, diagnosticText); } catch { /* Preserve the diagnostic in the durable record even if output cannot be written. */ }
      this.save(); error.refinementId = id; throw error;
    }
    finally { this.busy = false; this.controller = null; this.onChange(); }
  }
  shutdown() { this.controller?.abort(); }
}
