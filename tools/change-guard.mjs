#!/usr/bin/env node
// Validate pinned index blobs. Never stage, rewrite, or persist project state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG = '.change-guard.json';
const DIFF = ['diff', '--cached', '--raw', '--no-abbrev', '--no-ext-diff', '--no-textconv',
  '--find-renames=100%', '--diff-filter=ACDMRTU', '-z', '--'];
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = reason => ({ code: 2, reason, errors: [], advisories: [] });

function git(repo, args, maxBuffer = 32 * 1024 * 1024) {
  const result = spawnSync('git', args, { cwd: repo, windowsHide: true, timeout: 30000, maxBuffer });
  if (result.error || result.status !== 0) throw new Error('git');
  return result.stdout;
}

function entries(raw) {
  if (!raw.length) return [];
  const fields = decode(raw).split('\0');
  if (fields.pop() !== '') throw new Error('index');
  const found = [];
  for (let i = 0; i < fields.length;) {
    const record = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([ACDMRTU])(?:\d+)?$/.exec(fields[i++]);
    if (!record || record[5] === 'U' || (record[5] !== 'D' && /^0+$/.test(record[4]))) throw new Error('index');
    let name = fields[i++];
    if (['R', 'C'].includes(record[5])) name = fields[i++];
    if (!name) throw new Error('index');
    if (record[2] !== '160000') found.push({ name, mode: record[2], oid: record[4], status: record[5] });
  }
  return found;
}

function configOid(repo) {
  const staged = decode(git(repo, ['ls-files', '--stage', '-z', '--', CONFIG]));
  if (!staged) return null;
  const match = /^100(?:644|755) ([a-f0-9]+) 0\t\.change-guard\.json\0$/.exec(staged);
  if (!match) throw new Error('config');
  return match[1];
}

function blob(repo, oid) {
  const size = Number(decode(git(repo, ['cat-file', '-s', oid])).trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('git');
  return git(repo, ['cat-file', 'blob', oid], Math.max(size + 4096, 8192));
}

function config(repo, oid) {
  if (!oid) return [];
  let value;
  try { value = JSON.parse(decode(blob(repo, oid))); } catch { throw new Error('config'); }
  if (value.version !== 1 || !Array.isArray(value.allow)) throw new Error('config');
  return value.allow.map(rule => {
    if (!['html-ui', 'temporary-artifact'].includes(rule.rule) || typeof rule.path !== 'string' ||
        !rule.path || rule.path.startsWith('/') || rule.path.includes('\\') || rule.path.includes('..') ||
        typeof rule.reason !== 'string' || !rule.reason.trim()) throw new Error('config');
    const pattern = rule.path.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '.*');
    return { rule: rule.rule, pattern: new RegExp(`^${pattern}$`) };
  });
}

function temporary(name) {
  const parts = name.toLowerCase().split('/');
  const file = parts.at(-1);
  return parts.slice(0, -1).some(part => ['tmp', 'temp', 'scratch', 'scratchpad', 'screenshots',
    'exports', 'captures', 'handoffs', 'agent-plans', 'audit-transcripts', '.playwright-mcp',
    '.next', 'node_modules', '.vercel', '.netlify', '.cache', 'coverage'].includes(part)) ||
    /\.(?:log|tmp|temp|bak|orig|swp|swo)$/.test(file) ||
    /^(?:screenshot|screen[-_ ]?shot|playwright|poc[-_]|explainer[-_]|expl[-_]?first).*\.(?:png|jpe?g|webp)$/.test(file) ||
    /^(?:checklist\.md|handoff(?:[-_.].*)?\.md|agent[-_](?:prompt|plan|brief).*)$/.test(file) ||
    /(?:\.raw\.json|\.dump\.(?:json|jsonl|sql|csv))$/.test(file);
}

function htmlFixture(name) {
  return /(?:^|\/)(?:tests?\/fixtures|__fixtures__|fixtures)\//.test(name);
}

function reactEntryShell(name, bytes) {
  if (path.posix.basename(name).toLowerCase() !== 'index.html') return false;
  const text = decode(bytes).replace(/<!--[^]*?-->/g, '');
  const scripts = [...text.matchAll(/<script\b([^>]*)>([^]*?)<\/script\s*>/gi)];
  if (scripts.length !== 1 || scripts[0][2].trim() || !/\btype\s*=\s*(['"])module\1/i.test(scripts[0][1]) ||
      !/\bsrc\s*=\s*(['"])[^'"]+\1/i.test(scripts[0][1]) || /<style\b|\son\w+\s*=/i.test(text)) return false;
  let body = text.replace(scripts[0][0], '');
  const head = /<head\b[^>]*>([^]*?)<\/head\s*>/i.exec(body);
  if (head && head[1].replace(/<(?:meta|link)\b[^>]*>|<title\b[^>]*>[^]*?<\/title\s*>/gi, '').trim()) return false;
  body = body.replace(/<head\b[^>]*>[^]*?<\/head\s*>/i, '');
  const root = /<div\s+id\s*=\s*(['"])root\1\s*>\s*<\/div\s*>/i;
  if (!root.test(body)) return false;
  body = body.replace(root, '').replace(/<!doctype[^>]*>|<\/?(?:html|body)\b[^>]*>/gi, '');
  return !body.trim();
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function defaultRequirementsPath(repo, downloads = path.join(os.homedir(), 'Downloads')) {
  const identity = process.platform === 'win32' ? path.resolve(repo).toLowerCase() : path.resolve(repo);
  const label = path.basename(repo).replace(/[^a-zA-Z0-9_-]/g, '_') || 'project';
  return path.join(downloads, 'agent-work', `${label}-${hash(identity).slice(0, 12)}`, 'requirements.json');
}

function requirements(filename, repo) {
  try {
    const real = fs.realpathSync(filename);
    if (!fs.statSync(real).isFile() || within(fs.realpathSync(repo), real)) throw new Error();
    // State belongs outside every repository, including a different nested project.
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(real), windowsHide: true });
    if (probe.status === 0 || probe.error) throw new Error();
    const bytes = fs.readFileSync(real);
    const value = JSON.parse(decode(bytes));
    if (value.version !== 1 || !Array.isArray(value.items) || !value.items.length) throw new Error();
    const ids = new Set();
    const errors = [];
    for (const item of value.items) {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(item.id) || ids.has(item.id) ||
          typeof item.literal !== 'string' || !item.literal.trim() || !Array.isArray(item.evidence)) throw new Error();
      ids.add(item.id);
      if (item.status !== 'completed') errors.push({ rule: 'requirement-open', id: item.id });
      if (!item.evidence.length || item.evidence.some(file => typeof file !== 'string' || !path.isAbsolute(file) ||
          !fs.existsSync(file) || !fs.statSync(file).isFile())) errors.push({ rule: 'requirement-evidence', id: item.id });
    }
    return { errors, real, digest: hash(bytes), items: value.items.length };
  } catch { throw new Error('requirements'); }
}

export function checkStaged({ repo = process.cwd(), requirements: requirementFile } = {}) {
  try {
    repo = decode(git(repo, ['rev-parse', '--show-toplevel'])).trim();
    const raw = git(repo, DIFF);
    const oid = configOid(repo);
    const allowed = config(repo, oid);
    const changes = entries(raw);
    const errors = [];
    const advisories = [];
    const summary = { changedFiles: changes.length, newFiles: 0, newBytes: 0, addedLines: 0, removedLines: 0 };
    const stats = decode(git(repo, ['diff', '--cached', '--numstat', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', '--']));
    const binary = new Set();
    for (const field of stats.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(field);
      if (!match) throw new Error('index');
      if (match[1] === '-') binary.add(match[3]);
      else { summary.addedLines += Number(match[1]); summary.removedLines += Number(match[2]); }
    }
    for (const entry of changes.filter(item => ['A', 'C'].includes(item.status))) {
      summary.newFiles++;
      const size = Number(decode(git(repo, ['cat-file', '-s', entry.oid])).trim());
      summary.newBytes += size;
      if (binary.has(entry.name)) advisories.push({ rule: 'new-binary', file: entry.name, bytes: size });
      const exempt = rule => allowed.some(item => item.rule === rule && item.pattern.test(entry.name));
      if (temporary(entry.name) && !exempt('temporary-artifact')) errors.push({ rule: 'temporary-artifact', file: entry.name });
      if (/\.html?$/i.test(entry.name) && entry.mode !== '120000' && !htmlFixture(entry.name) && !exempt('html-ui')) {
        const bytes = blob(repo, entry.oid);
        if (/<\s*(?:html|body|main|nav|section|article|div|p|h[1-6]|form|button|input|style|script|svg|canvas|table)\b/i.test(decode(bytes)) &&
            !reactEntryShell(entry.name, bytes)) errors.push({ rule: 'html-ui', file: entry.name });
      }
    }
    const closure = requirementFile ? requirements(requirementFile, repo) : null;
    if (closure) errors.push(...closure.errors);
    if (!git(repo, DIFF).equals(raw) || configOid(repo) !== oid) return failure('index-changed');
    if (closure && hash(fs.readFileSync(closure.real)) !== closure.digest) return failure('requirements-changed');
    return { code: errors.length ? 1 : 0, errors, advisories, summary,
      requirementsChecked: closure?.items ?? 0, defaultRequirementsPath: defaultRequirementsPath(repo) };
  } catch (error) {
    return failure(['git', 'index', 'config', 'requirements'].includes(error.message) ? error.message : 'input');
  }
}

export function formatResult(result) {
  if (result.code === 2) return `[change-guard] BLOCKED: incomplete check (${result.reason}).`;
  const lines = [`[change-guard] ${result.code ? 'BLOCKED' : 'OK'}: ${result.summary.newFiles} new file(s), ` +
    `${result.summary.newBytes} bytes, +${result.summary.addedLines}/-${result.summary.removedLines} lines.`];
  for (const error of result.errors) lines.push(`  ${error.rule}: ${JSON.stringify(error.file ?? error.id)}`);
  for (const advisory of result.advisories) lines.push(`  Review new binary ${JSON.stringify(advisory.file)} (${advisory.bytes} bytes).`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (!['--repo', '--requirements'].includes(args[i]) || !args[i + 1]) {
      process.stderr.write('Usage: node tools/change-guard.mjs [--repo PATH] [--requirements EXTERNAL_JSON] [--json]\n');
      process.exitCode = 2; return;
    }
    options[args[i] === '--repo' ? 'repo' : 'requirements'] = args[++i];
  }
  const result = checkStaged(options);
  (json ? process.stdout : process.stderr).write((json ? JSON.stringify(result) : formatResult(result)) + '\n');
  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
