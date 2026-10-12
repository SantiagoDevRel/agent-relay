import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectProjects, browseProjectFolders } from '../server/projects.mjs';
test('project choices deduplicate folders and retain nested project context and real Git roots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-projects-')), project = path.join(dir, 'project'), nested = path.join(project, 'src'), other = path.join(dir, 'other');
  fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(other);
  const git = args => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
  try {
    git(['init']); fs.writeFileSync(path.join(nested, 'feature.mjs'), 'export const value = 1;');
    const result = await collectProjects({ workspace: project, topics: [], chats: [{ cwd: nested }, { cwd: project }, { cwd: other }, { cwd: 'fake-label' }], missions: [{ project }, { project: path.join(dir, 'missing') }] });
    assert.equal(result.projects.length, 2);
    const selected = result.projects.find(value => value.path === nested);
    assert.equal(selected.gitRoot, project); assert.equal(selected.dirty, true);
    assert.equal(result.projects.filter(value => value.path === project).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workspace and topic project choices do not need a previous chat and remain available when status times out', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-'));
  const mcp = path.join(workspace, 'projects', 'example-team', 'MCP'), hidden = path.join(workspace, '.secrets');
  fs.mkdirSync(mcp, { recursive: true }); fs.mkdirSync(hidden);
  try {
    const result = await collectProjects({ workspace, topics: [mcp], chats: [{ cwd: hidden }], exec: async (_bin, args) => {
      if (args[0] === 'status') throw Error('status timed out');
      return { stdout: workspace };
    } });
    assert.deepEqual(new Set(result.projects.map(value => value.path)), new Set([workspace, mcp]));
    assert.equal(result.projects.find(value => value.label === 'MCP').gitRoot, workspace);
    assert.equal('dirty' in result.projects.find(value => value.label === 'MCP'), false, 'unknown status is not marked clean');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('folder navigation starts at the workspace and lists real children and selected ancestry without scanning runtimes', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-folders-'));
  const mcp = path.join(workspace, 'projects', 'example-team', 'MCP');
  for (const folder of ['main', 'ethrome', '.secrets', 'node_modules', 'dist', 'build', 'coverage', '__pycache__']) fs.mkdirSync(path.join(mcp, folder), { recursive: true });
  fs.writeFileSync(path.join(mcp, 'README.md'), 'not a directory');
  const exec = async () => ({ stdout: workspace });
  try {
    const initial = await browseProjectFolders({ workspace, exec });
    assert.equal(initial.current.path, workspace); assert.equal(initial.root.path, workspace);
    assert.deepEqual(initial.folders.map(value => value.label), ['projects']);
    const selected = await browseProjectFolders({ workspace, folder: mcp, exec });
    assert.deepEqual(selected.breadcrumbs.map(value => value.label).slice(1), ['projects', 'example-team', 'MCP']);
    assert.deepEqual(selected.folders.map(value => value.label), ['ethrome', 'main']);
    assert.equal(selected.current.gitRoot, workspace);
    const main = await browseProjectFolders({ workspace, folder: path.join(mcp, 'main'), exec: async () => { throw Error('not Git'); } });
    assert.deepEqual(main.folders, []); assert.equal('gitRoot' in main.current, false);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('folder navigation rejects traversal, missing paths, hidden paths and linked ancestors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-folder-guards-')), workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside');
  fs.mkdirSync(workspace); fs.mkdirSync(outside); fs.mkdirSync(path.join(workspace, '.secrets'));
  const exec = async () => ({ stdout: workspace });
  try {
    fs.symlinkSync(outside, path.join(workspace, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(browseProjectFolders({ workspace, folder: outside, exec }), error => error.status === 403);
    await assert.rejects(browseProjectFolders({ workspace, folder: path.join(workspace, '.secrets'), exec }), error => error.status === 403);
    await assert.rejects(browseProjectFolders({ workspace, folder: path.join(workspace, 'external'), exec }), error => error.status === 403);
    await assert.rejects(browseProjectFolders({ workspace, folder: path.join(workspace, 'missing'), exec }), error => error.status === 404);
    await assert.rejects(browseProjectFolders({ workspace, folder: '../outside', exec }), error => error.status === 400);
    await assert.rejects(browseProjectFolders({ workspace, folder: workspace + '\u0000', exec }), error => error.status === 400);
    assert.deepEqual((await browseProjectFolders({ workspace, exec })).folders, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
