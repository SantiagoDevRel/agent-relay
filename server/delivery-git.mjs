// Fixed read-only Git/GitHub argv. Fetch changes remote-tracking refs only.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attributeWorktrees, pathKey } from './delivery-transcript.mjs';
import './config.mjs';

export function execute(file, args, { cwd, input = '', timeout = 8000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error(`${file} timed out`)); }, timeout);
    child.stdout.on('data', b => { size += b.length; if (size > maxBuffer) { child.kill(); reject(Error(`${file} output exceeded its bound`)); } else output.push(b); });
    child.stderr.on('data', b => { if (errors.length < 8) errors.push(b.subarray(0, 4096)); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(output).toString('utf8')); else reject(Object.assign(Error(`${file} exited ${code}`), { code, detail: Buffer.concat(errors).toString('utf8') })); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export function parseWorktrees(text) {
  return text.trim().split(/\n\n/).filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split('\n').map(line => { const at = line.indexOf(' '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)]; }));
    return { path: fields.worktree, head: fields.HEAD, branch: String(fields.branch || '').replace(/^refs\/heads\//, '') || '(detached)' };
  }).filter(w => w.path && !w.path.includes('\n'));
}

export function matchesPattern(file, patterns) {
  return patterns.some(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '.*');
    return new RegExp('^' + escaped + '$', 'i').test(file);
  });
}
const defaults = { ignored: ['.next*/**', '**/.next*/**', 'node_modules/**', '**/node_modules/**', 'dist/**', '**/dist/**', '*.tsbuildinfo', '**/*.tsbuildinfo', 'supabase/.temp/**'], collisionIgnored: ['**/*.md', '*.md', 'docs/**', 'guides/**', '**/docs/**', '**/guides/**', '**/AGENTS.md', '**/CLAUDE.md', '**/*generated*', '**/*index.generated*', '.playwright-mcp/**', '.ai-chat-home*/**', '.claude/**', '.codex/**', '**/__pycache__/**', '**/.cache/**'] };
export function configFor(root) {
  let config = {};
  let localDefault = null;
  if (process.env.CHATS_DELIVERY_DEFAULTS_FILE) {
    const file = process.env.CHATS_DELIVERY_DEFAULTS_FILE;
    if (fs.statSync(file).size > 64000) throw Error('Private Delivery defaults exceed 64 KB');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid private Delivery defaults');
    for (const [name, ref] of Object.entries(value)) {
      if (!name || /[\\/\x00-\x1f]/.test(name) || typeof ref !== 'string' || !/^origin\/[\w./-]+$/.test(ref) || ref.includes('..')) throw Error('Invalid private Delivery default');
      if (name.toLowerCase() === path.basename(root).toLowerCase()) localDefault = ref;
    }
  }
  try {
    const file = path.join(root, '.agent-relay-delivery.json');
    if (fs.statSync(file).size > 64000) throw Error('Delivery configuration exceeds 64 KB');
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of ['ignored', 'collisionIgnored']) if (config[name] !== undefined && (!Array.isArray(config[name]) || config[name].length > 128 || config[name].some(p => typeof p !== 'string' || p.length > 300))) throw Error('Invalid Delivery exclusion patterns');
  for (const name of ['mainRef', 'productionRef']) if (config[name] !== undefined && config[name] !== null && (typeof config[name] !== 'string' || !/^origin\/[\w./-]+$/.test(config[name]) || config[name].includes('..'))) throw Error('Delivery refs must be origin remote-tracking refs');
  return { ...defaults, productionRef: localDefault, ignoreNextDistEntries: true, ...config };
}

export function nextConfigWithoutGenerated(value) {
  const data = JSON.parse(value);
  if (Array.isArray(data.include)) data.include = data.include.filter(item => !/(?:^|\/)\.next[^/]*\/.*types\//.test(item));
  return JSON.stringify(data);
}

export async function patchId(exec, cwd, patch) {
  const text = await exec('git', ['patch-id', '--stable'], { cwd, input: patch });
  return text.trim().split(/\s+/)[0] || null;
}

export function collisionsFor(rows, config) {
  const files = new Map();
  for (const row of rows.filter(row => row.active)) {
    for (const file of new Set(row.files || [])) {
      const code = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kts?|scala|cs|c|cc|cpp|cxx|h|hpp|hxx|swift|mm?|dart|vue|svelte|astro|css|scss|sass|less|html?|sql|sh|bash|ps1|psm1|bat|cmd|r|exs?|erl|hrl|clj[sc]?|edn|el|lua|pl|pm|tf|tfvars|json|ya?ml|toml|sol|vy|gql|graphql|proto|zig|nim|jl|fish|zsh|cmake|gradle|groovy|tcl|v|vhdl?|sv|sbt|razor|cshtml|xaml|xml)$/i.test(file) || /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|Makefile|CMakeLists\.txt)$/i.test(file);
      if (!code || matchesPattern(file, [...config.ignored, ...config.collisionIgnored])) continue;
      const ids = files.get(file) || new Set(); ids.add(row.chatId); files.set(file, ids);
    }
  }
  return [...files].filter(([, ids]) => ids.size > 1).map(([file, ids]) => ({ file, chats: [...ids].sort() })).sort((a, b) => a.file.localeCompare(b.file));
}

export function applyProjectCollisions(values, repo, activeChatIds) {
  const project = [...values.values()].filter(value => pathKey(value.project) === pathKey(repo.root));
  for (const value of project) for (const lane of value.lanes) lane.active = activeChatIds.has(lane.chatId);
  const collisions = collisionsFor(project.filter(value => value.state === 'attributed').flatMap(value => value.lanes), repo.config);
  for (const value of project) {
    value.collisions = collisions;
    for (const lane of value.lanes) lane.collisions = collisions.filter(c => c.chats.includes(lane.chatId) && lane.files.includes(c.file)).map(c => c.file);
  }
}

export class DeliveryGit {
  constructor({ exec = execute, now = () => Date.now(), network = true } = {}) { this.exec = exec; this.now = now; this.network = network; this.remote = new Map(); this.lanes = new Map(); this.laneFailures = new Map(); this.roots = new Map(); this.ci = new Map(); this.patches = new Map(); }
  git(cwd, args, options) { return this.exec('git', args, { cwd, ...options }); }
  async optional(cwd, args) { try { return (await this.git(cwd, args)).trim(); } catch { return null; } }
  async root(cwd) {
    if (!cwd) return null;
    const hit = this.roots.get(pathKey(cwd));
    if (hit && this.now() - hit.at < 30000) return hit.root;
    let root;
    try { root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) { if (/not a git repository/i.test(error.detail || '')) root = null; else throw error; }
    this.roots.set(pathKey(cwd), { root, at: this.now() }); return root;
  }
  async repository(root) {
    const config = configFor(root), at = this.now();
    const remote = this.remote.get(pathKey(root)) || { at: -Infinity };
    const url = await this.optional(root, ['remote', 'get-url', 'origin']);
    let error = '';
    if (this.network && url && at - remote.at >= 120000) {
      remote.at = at; this.remote.set(pathKey(root), remote);
      try { await this.git(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { timeout: 20000 }); }
      catch { error = 'Fetch unavailable; showing cached remote refs.'; }
    }
    let mainRef = config.mainRef || (await this.optional(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']));
    // Missing origin/HEAD is resolved by provider metadata, never guessed as main/master.
    if (!mainRef && url && this.network) {
      if (!remote.defaultAt || at - remote.defaultAt >= 120000) {
        remote.defaultAt = at; this.remote.set(pathKey(root), remote);
        try { const data = JSON.parse(await this.exec('gh', ['repo', 'view', '--json', 'defaultBranchRef'], { cwd: root })); remote.mainRef = data.defaultBranchRef?.name ? 'origin/' + data.defaultBranchRef.name : null; } catch { /* Unknown. */ }
      }
      mainRef = remote.mainRef || null;
    }
    const mainSha = mainRef ? await this.optional(root, ['rev-parse', '--verify', mainRef + '^{commit}']) : null;
    const productionSha = config.productionRef ? await this.optional(root, ['rev-parse', '--verify', config.productionRef + '^{commit}']) : null;
    const worktrees = parseWorktrees(await this.git(root, ['worktree', 'list', '--porcelain']));
    return { root, config, mainRef, mainSha, productionRef: productionSha ? config.productionRef : null, productionSha, worktrees, error };
  }
  async ancestor(cwd, sha, ref) {
    if (!sha || !ref) return null;
    try { await this.git(cwd, ['merge-base', '--is-ancestor', sha, ref]); return true; }
    catch (error) { return error.code === 1 ? false : null; }
  }
  async ciFor(root, sha, mainRef) {
    if (!sha || !mainRef) return { state: 'unknown', runs: [] };
    const key = pathKey(root) + ':' + sha + ':' + mainRef, hit = this.ci.get(key);
    if (hit && this.now() - hit.at < 120000) return hit.value;
    let value = { state: 'unknown', runs: [] };
    if (this.network) {
      try {
        const branch = mainRef.slice('origin/'.length);
        const runs = JSON.parse(await this.exec('gh', ['run', 'list', '--branch', branch, '--commit', sha, '--limit', '100', '--json', 'databaseId,url,status,conclusion,headSha,headBranch,workflowName,event'], { cwd: root }));
        const exact = runs.filter(r => r.headSha === sha && r.headBranch === branch && r.event === 'push');
        const latest = new Map(); for (const run of exact) if (!latest.has(run.workflowName) || latest.get(run.workflowName).databaseId < run.databaseId) latest.set(run.workflowName, run);
        const selected = [...latest.values()];
        value = { state: selected.some(r => ['failure', 'timed_out', 'action_required'].includes(r.conclusion)) ? 'failure' : selected.some(r => r.status !== 'completed') ? 'pending' : selected.length && selected.every(r => ['success', 'skipped', 'neutral'].includes(r.conclusion)) ? 'success' : 'unknown', runs: selected };
        if (runs.length === 100) value = { ...value, state: 'unknown', error: 'CI result bound reached' };
      } catch { value.error = 'GitHub Actions unavailable'; }
    }
    this.ci.set(key, { at: this.now(), value }); return value;
  }
  async laneCi(repo, lane) {
    if (lane.onMain !== true || !lane.mainCommit) return { state: 'unknown', runs: [] };
    const result = await this.ciFor(repo.root, lane.mainCommit, repo.mainRef);
    // A side-branch commit can be contained in main without ever triggering a
    // main-branch run itself. The current main SHA provably contains that lane.
    return result.state === 'unknown' && !result.error && !result.runs.length && lane.mainCommit !== repo.mainSha
      ? this.ciFor(repo.root, repo.mainSha, repo.mainRef) : result;
  }
  async lane(repo, worktree) {
    const key = pathKey(worktree.path), failed = this.laneFailures.get(key);
    if (failed && this.now() - failed.at < 30000) throw failed.error;
    try { const result = await this.readLane(repo, worktree); this.laneFailures.delete(key); return result; }
    catch (error) { this.laneFailures.set(key, { at: this.now(), error }); throw error; }
  }
  async readLane(repo, worktree) {
    const cwd = worktree.path, previous = this.lanes.get(pathKey(cwd));
    if (previous && this.now() - previous.at < 30000) return previous.value;
    const head = await this.optional(cwd, ['rev-parse', 'HEAD']);
    if (!head) throw Error('Worktree unavailable');
    const index = await this.optional(cwd, ['rev-parse', '--git-path', 'index']);
    let indexKey = ''; try { const st = fs.statSync(path.resolve(cwd, index)); indexKey = `${st.mtimeMs}:${st.size}`; } catch { /* Unknown index. */ }
    const status = await this.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 8000 });
    const parts = status.split('\0');
    let fileCount = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (++fileCount > 4096) throw Error('Worktree changes exceed the 4096-file bound');
      if (/[RC]/.test(parts[i].slice(0, 2))) i++;
    }
    const dirtyMetadata = parts.filter(Boolean).map(line => {
      try { const stat = fs.statSync(path.join(cwd, line.slice(3))); return `${stat.mtimeMs}:${stat.size}`; } catch { return '?'; }
    }).join('|');
    const signature = [head, worktree.branch, indexKey, status, dirtyMetadata, repo.mainRef, repo.mainSha, repo.productionSha].join('|');
    const cached = this.lanes.get(pathKey(cwd));
    // Unstaged paths are always enumerated; HEAD/index cache alone misses them.
    if (cached?.signature === signature) {
      cached.value = { ...cached.value, ci: await this.laneCi(repo, cached.value) };
      cached.at = this.now();
      return cached.value;
    }
    const localFiles = [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      const line = parts[i], file = line.slice(3);
      if (/[RC]/.test(line.slice(0, 2))) i++;
      if (matchesPattern(file, repo.config.ignored)) continue;
      if (repo.config.ignoreNextDistEntries && (file === 'tsconfig.json' || file.endsWith('/tsconfig.json'))) {
        try {
          const before = await this.git(cwd, ['show', 'HEAD:' + file]);
          if (nextConfigWithoutGenerated(before) === nextConfigWithoutGenerated(fs.readFileSync(path.join(cwd, file), 'utf8'))) continue;
        } catch { /* Count it when equivalence cannot be proved. */ }
      }
      localFiles.push(file);
    }
    let committed = null, onMain = null, mainCommit = null, method = '', files = [...localFiles], error = '';
    if (repo.mainSha) {
      onMain = await this.ancestor(cwd, head, repo.mainSha);
      const base = await this.optional(cwd, ['merge-base', repo.mainSha, head]);
      if (base) {
        const ahead = (await this.git(cwd, ['rev-list', '--max-count=257', repo.mainSha + '..' + head])).trim().split('\n').filter(Boolean);
        committed = ahead.length;
        if (ahead.length > 256) { committed = null; onMain = null; error = 'Lane exceeds 256 commit bound'; }
        else if (onMain) { mainCommit = head; method = 'ancestry'; }
        else if (ahead.length) {
          const mainCommits = (await this.git(cwd, ['rev-list', '--max-count=257', base + '..' + repo.mainSha])).trim().split('\n').filter(Boolean);
          if (mainCommits.length > 256) { onMain = null; error = 'Main patch comparison exceeds 256 commit bound'; }
          else {
            const key = repo.mainSha + ':' + base;
            let patches = this.patches.get(key);
            if (!patches) {
              const output = await this.exec('git', ['patch-id', '--stable'], { cwd, input: await this.git(cwd, ['log', '--format=commit %H', '-p', '--no-merges', '--no-ext-diff', '--no-textconv', base + '..' + repo.mainSha]) });
              patches = new Map(output.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)));
              this.patches.set(key, patches);
              if (this.patches.size > 128) this.patches.delete(this.patches.keys().next().value);
            }
            const output = await this.exec('git', ['patch-id', '--stable'], { cwd, input: await this.git(cwd, ['log', '--format=commit %H', '-p', '--no-merges', '--no-ext-diff', '--no-textconv', repo.mainSha + '..' + head]) });
            const laneIds = new Map(output.trim().split('\n').filter(Boolean).map(line => { const [id, sha] = line.split(/\s+/); return [sha, id]; }));
            const mapped = ahead.map(sha => patches.get(laneIds.get(sha)));
            if (mapped.every(Boolean)) { onMain = true; mainCommit = mainCommits.find(sha => mapped.includes(sha)); method = 'patch-id (rebase)'; }
            else {
              const combined = await patchId(this.exec, cwd, await this.git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, head]));
              if (combined && patches.has(combined)) { onMain = true; mainCommit = patches.get(combined); method = 'patch-id (squash)'; }
            }
          }
        }
        // Integrated changes no longer collide: compare pending code to merge-base.
        const changed = await this.git(cwd, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', base, head]);
        files.push(...changed.split('\0').filter(Boolean));
      }
    }
    const production = repo.productionSha ? (mainCommit || onMain === false ? await this.ancestor(cwd, mainCommit || head, repo.productionSha) : null) : undefined;
    const value = { worktree: cwd, branch: worktree.branch, head, local: localFiles.length, localFiles, committed, onMain, mainCommit, method, production, productionRef: repo.productionRef, productionSha: repo.productionSha, mainRef: repo.mainRef, files: [...new Set(files)].filter(f => !matchesPattern(f, repo.config.ignored)), error,
      ci: await this.laneCi(repo, { onMain, mainCommit }) };
    this.lanes.set(pathKey(cwd), { at: this.now(), signature, value }); return value;
  }
  async chat(repo, chat, transcript) {
    const worktrees = attributeWorktrees(transcript.paths, repo.worktrees);
    const lanes = [];
    for (const worktree of worktrees) {
      try {
        const lane = await this.lane(repo, worktree);
        const report = transcript.report;
        let verification = { state: 'not reported', text: '' };
        if (transcript.complete && report && repo.productionSha) {
          const sha = await this.optional(repo.root, ['rev-parse', '--verify', report.sha + '^{commit}']);
          if (sha && await this.ancestor(repo.root, sha, repo.productionSha) && (sha === lane.head || sha === lane.mainCommit)) verification = { state: 'verified', text: report.verified, sha, ci: report.ci, prod: report.prod };
          else verification = { state: 'not reported', text: '', rejected: 'Reported SHA is not this lane on production' };
        }
        lanes.push({ ...lane, verification, chatId: chat.id, active: chat.alive && !chat.automated, collisions: [] });
      } catch (error) { lanes.push({ worktree: worktree.path, branch: worktree.branch, chatId: chat.id, active: chat.alive && !chat.automated, error: error.message, files: [], collisions: [], ci: { state: 'unknown', runs: [] }, verification: { state: 'not reported', text: '' } }); }
    }
    return { state: !transcript.complete ? 'unknown' : lanes.length ? 'attributed' : transcript.paths.length || transcript.entire === false ? 'unknown' : 'no-code', coverage: transcript.complete ? transcript.entire === false ? 'bounded window' : 'complete' : 'partial', lanes, project: repo.root, checkedAt: this.now(), error: repo.error, attention: [] };
  }
}
