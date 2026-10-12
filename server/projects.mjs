// Project choices and folder navigation use the filesystem, never client labels.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { WORKSPACE, TOPICS_FILE } from './config.mjs';
const execute = promisify(execFile);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
export const PROJECT_WORKSPACE = WORKSPACE;
const hidden = name => name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', '__pycache__'].includes(name.toLowerCase());
const fail = (message, status) => Object.assign(Error(message), { status });
const inside = (root, folder) => { const relative = path.relative(root, folder); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

function topicFolders(workspace) {
  try {
    const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')).topics || [];
    return topics.flatMap(topic => topic.folders || []).map(folder => folder.startsWith('~/') ? path.resolve(os.homedir(), folder.slice(2)) : path.resolve(workspace, folder));
  } catch { return []; }
}

export async function collectProjects({ chats = [], missions = [], workspace = PROJECT_WORKSPACE, topics = topicFolders(workspace), exec = execute } = {}) {
  const folders = [...new Set([workspace, ...topics, ...chats.map(chat => chat.cwd), ...missions.map(job => job.project)]
    .filter(folder => typeof folder === 'string' && path.isAbsolute(folder) && !/[\x00-\x1f]/.test(folder)).map(folder => path.resolve(folder)))].slice(0, 128);
  const projects = new Map(), errors = [];
  let next = 0;
  async function worker() {
    while (next < folders.length) {
      const folder = folders[next++];
      try {
        if (inside(workspace, folder) && path.relative(workspace, folder).split(path.sep).filter(Boolean).some(hidden)) continue;
        if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) continue;
        const options = { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 128000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
        const root = path.resolve((await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim());
        const id = key(folder), prior = projects.get(id);
        if (prior) { if (!prior.folders.includes(folder)) prior.folders.push(folder); continue; }
        // A large parent repository must not hide valid topic choices when status times out.
        let dirty;
        try { dirty = Boolean((await exec('git', ['status', '--porcelain', '--untracked-files=normal', '--', path.relative(root, folder) || '.'], { ...options, cwd: root })).stdout.trim()); } catch { /* Unknown, not falsely clean. */ }
        const entry = { path: folder, gitRoot: root, label: path.basename(folder), ...(dirty !== undefined ? { dirty } : {}), folders: [folder] };
        const existing = projects.get(id);
        if (existing) existing.folders.push(...entry.folders.filter(value => !existing.folders.includes(value)));
        else projects.set(id, entry);
      } catch { /* Missing and non-Git folders do not become launch targets. */ }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (folders.length === 128) errors.push('Quick choices are limited to 128 folders. Browse the workspace dropdowns for every other project.');
  return { projects: [...projects.values()].sort((a, b) => a.label.localeCompare(b.label)), errors };
}

export async function browseProjectFolders({ folder, workspace = PROJECT_WORKSPACE, exec = execute } = {}) {
  const root = path.resolve(workspace);
  const selected = folder === undefined || folder === '' ? root : folder;
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.length > 1000 || /[\x00-\x1f]/.test(selected)) throw fail('Select a valid absolute workspace folder.', 400);
  const currentPath = path.resolve(selected);
  if (!inside(root, currentPath)) throw fail('Folder navigation is limited to the configured workspace.', 403);
  const relative = path.relative(root, currentPath), segments = relative ? relative.split(path.sep) : [];
  if (segments.some(hidden)) throw fail('Hidden and runtime folders are not project choices.', 403);
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
    for (let level = 0; level <= segments.length; level++) {
      const candidate = path.join(root, ...segments.slice(0, level));
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(rootReal, fs.realpathSync(candidate))) throw fail('Linked or non-directory paths are not project choices.', 403);
    }
  } catch (error) { if (error.status) throw error; throw fail('This project folder is no longer available.', error.code === 'ENOENT' ? 404 : 403); }
  let entries;
  try { entries = await fs.promises.readdir(currentPath, { withFileTypes: true }); }
  catch { throw fail('This folder cannot be read. Choose another folder or retry.', 403); }
  const folders = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !hidden(entry.name))
    .map(entry => ({ path: path.join(currentPath, entry.name), label: entry.name })).sort((a, b) => a.label.localeCompare(b.label));
  const current = { path: currentPath, label: path.basename(currentPath) };
  try { current.gitRoot = path.resolve((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: currentPath, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 128000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim()); }
  catch { /* Browsing non-Git folders is allowed; launch validation remains separate. */ }
  return { root: { path: root, label: path.basename(root) }, current,
    breadcrumbs: [{ path: root, label: path.basename(root) }, ...segments.map((label, index) => ({ path: path.join(root, ...segments.slice(0, index + 1)), label }))], folders, errors: [] };
}
