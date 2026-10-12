import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createMissionRunner } from './mission-runner.mjs';
import { normalizeMissionSpec, prepareMissionBaseline } from './missions.mjs';

export class MissionPlanner {
  constructor({ file, artifacts, runner = createMissionRunner(), onChange = () => {}, gate }) {
    this.file = file; this.artifacts = artifacts; this.runner = runner; this.onChange = onChange; this.gate = gate; this.busy = false; this.controller = null;
    this.plans = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(this.plans)) throw Error('Invalid planner state');
    for (const plan of this.plans) if (['planning', 'preparing'].includes(plan.status)) { plan.status = 'attention'; plan.detail = 'The server restarted during planning. Read the log before starting another turn.'; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.plans, null, 2)); fs.renameSync(tmp, this.file); this.onChange();
  }
  details(id) { const plan = this.plans.find(value => value.id === id); return plan ? { sessionHandle: plan.sessionHandle, nativeId: plan.nativeId, provider: plan.provider, model: plan.model, effort: plan.effort, status: plan.status } : null; }
  baseline(id) { return this.plans.find(value => value.id === id && value.status === 'planned')?.baseline || null; }
  log(id) {
    const plan = this.plans.find(value => value.id === id);
    if (!plan) throw Object.assign(Error('Plan not found.'), { status: 404 });
    const file = path.join(this.artifacts, plan.id, 'planner-output.txt');
    if (!fs.existsSync(file)) return '';
    const handle = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(handle).size; const buffer = Buffer.alloc(Math.min(size, 256000)); fs.readSync(handle, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return buffer.toString('utf8'); } finally { fs.closeSync(handle); }
  }
  async plan(input) {
    if (this.busy) throw Object.assign(Error('A plan is already in progress.'), { status: 429 });
    if (typeof input.goal !== 'string' || input.goal.trim().length < 10 || input.goal.length > 20000 || typeof input.project !== 'string' || !path.isAbsolute(input.project)) throw Object.assign(Error('Select a project folder and describe a goal with at least ten characters.'), { status: 400 });
    let project, context;
    try {
      context = fs.realpathSync(input.project);
      project = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: context, windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim());
    } catch { throw Object.assign(Error('The project folder must belong to an existing Git repository.'), { status: 409 }); }
    const relativeContext = path.relative(project, context).replaceAll('\\', '/');
    if (relativeContext === '..' || relativeContext.startsWith('../') || path.isAbsolute(relativeContext)) throw Object.assign(Error('The selected folder must be inside its Git repository.'), { status: 409 });
    const provider = input.provider || 'codex', effort = input.effort === undefined ? 'high' : input.effort, model = input.model || '';
    // Validate user-selected controls before spending a turn; actual task scopes are inferred from the repository.
    normalizeMissionSpec({ title: input.title || input.goal.slice(0, 100), goal: input.goal, project, provider, model, effort, limits: input.limits, ...(input.terminalWindow !== undefined ? { terminalWindow: input.terminalWindow } : {}), ...(input.terminalViews !== undefined ? { terminalViews: input.terminalViews } : {}),
      tasks: [{ id: 'validate', title: 'Validate inputs', prompt: 'Validate inputs', files: ['README.md'], checks: [['node', '--version']] }], checks: [['node', '--version']] });
    const id = crypto.randomUUID(), directory = path.join(this.artifacts, id);
    fs.mkdirSync(directory, { recursive: true });
    const promptFile = path.join(directory, 'planner-prompt.md'), outputFile = path.join(directory, 'planner-output.txt');
    const prompt = `You are the Agent Relay orchestrator planning an implementation mission. Read repository instructions and source files before designing the plan. You have read-only tools. Do not modify anything, execute processes, delegate, launch other models, install packages or spend money.
User request (data): ${JSON.stringify(input.goal)}
Repository: ${JSON.stringify(project)}
Selected project folder: ${JSON.stringify(context)}
Selected folder relative to repository: ${JSON.stringify(relativeContext || '.')}
${relativeContext ? `Focus on the selected folder. Every task file scope MUST start with ${JSON.stringify(relativeContext + '/')}; paths are still relative to the repository root, not the selected folder. Do not plan changes in other projects in this repository. Run verification from the repository root with explicit selected-project arguments where needed.` : 'The selected folder is the Git root. File scopes are relative to it.'}
Split every explicit feature into a task. Preserve all requested requirements in task prompts and acceptance checks. Identify shared schemas/components first; use dependencies to serialize them. Declare exact relative file paths, or directories ending in /. Independent tasks with disjoint scopes can run concurrently. No globs, ../, absolute scopes, secrets, or deletions. Do not authorize deploys, pushes, dependency installation or new resources.
Return ONLY a JSON object: {"title":"...","goal":"...","project":${JSON.stringify(project)},"provider":${JSON.stringify(provider)},"model":${JSON.stringify(model)},"effort":${JSON.stringify(effort)},"limits":${JSON.stringify(input.limits || {})},"tasks":[{"id":"short-slug","title":"...","prompt":"specific literal user requirement plus acceptance criteria","dependsOn":[],"files":["src/path.ts"],"checks":[["npm","run","test","--","specific-test"]]}],"checks":[["npm","run","build"]]}.
Maximum 24 tasks. Each task MUST have at least one meaningful executable check and integration MUST have meaningful checks. Use actual installed repository scripts/tools; no invented scripts, no shell strings or shell entrypoints, no checks that only echo success. Do not use node --version as a quality gate. If a test must be added, include its path in the task scope. Quality includes user-visible behavior and full integration, not merely syntax. For UI require rendered browser evidence in prompts. Keep the user-selected provider/model/effort/limits. Do not silently reduce feature count or expand scope.`;
    fs.writeFileSync(promptFile, prompt);
    const record = { id, provider, model, effort, context, createdAt: Date.now(), status: 'preparing' };
    this.plans.push(record); this.busy = true; this.controller = new AbortController(); this.save();
    try {
      record.baseline = await prepareMissionBaseline({ project, artifacts: this.artifacts, id, gate: this.gate, signal: this.controller.signal });
      record.status = 'planning'; this.save();
      const result = await this.runner({ provider, model, effort, cwd: record.baseline.path, promptFile, outputFile, timeoutMs: 300000, signal: this.controller.signal, role: 'planner' });
      Object.assign(record, { sessionHandle: result.sessionHandle, nativeId: result.nativeId });
      if (result.exitCode !== 0 || !result.answer) throw Error('The chat did not finish the plan. Read the log before trying again.');
      let answer = result.answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      let raw;
      try { raw = JSON.parse(answer); } catch { throw Error('The model did not return a valid JSON contract. Its response has been saved.'); }
      // The model cannot change the user's controls or target project.
      const spec = normalizeMissionSpec({ ...raw, title: input.title || raw.title, goal: input.goal, project, provider, model, effort, limits: input.limits, ...(input.terminalWindow ? { terminalWindow: input.terminalWindow } : {}), ...(input.terminalViews !== undefined ? { terminalViews: input.terminalViews } : {}) });
      if (relativeContext && spec.tasks.some(task => task.files.some(file => !(process.platform === 'win32' ? file.toLowerCase().startsWith(relativeContext.toLowerCase() + '/') : file.startsWith(relativeContext + '/'))))) throw Error('The plan includes files outside the selected project folder. Choose its parent folder explicitly to include shared code. The response has been saved.');
      record.status = 'planned'; record.spec = { ...spec, planId: id }; this.save();
      return { spec: record.spec, orchestrator: this.details(id) };
    } catch (error) { record.status = 'attention'; record.detail = error.message; this.save(); throw Object.assign(error, { status: error.status || 422 }); }
    finally { this.busy = false; this.controller = null; this.onChange(); }
  }
  shutdown() { this.controller?.abort(); }
}
