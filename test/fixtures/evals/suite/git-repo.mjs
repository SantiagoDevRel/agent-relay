// Synthetic git repositories for the E4c suite and runner tests. Text is invented.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Relay Evals Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

export function commit(root, files, message) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

export const ENGLISH = "export function greet(name, locale = 'en') { return `Hello, ${name}!`; }\n";
export const BILINGUAL = "export function greet(name, locale = 'en') { return locale === 'es' ? `Hola, ${name}!` : `Hello, ${name}!`; }\n";
const EN_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\ntest('english', () => assert.equal(greet('Ana'), 'Hello, Ana!'));\n";
const ES_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\ntest('spanish', () => assert.equal(greet('Ana', 'es'), 'Hola, Ana!'));\n";

// base: package.json test script + one test; a feature commit adds a test; a later fix
// commit modifies the pre-existing test. Returns { root, base, final }.
export function greetingRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  const base = commit(root, {
    'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test test/' } }, null, 2),
    'src/greet.mjs': ENGLISH, 'test/greet.test.mjs': EN_TEST, 'test/fixtures/data.test.mjs': '// fixture, not a test\n',
  }, 'Initial greeting');
  commit(root, { 'src/greet.mjs': BILINGUAL, 'test/greet-es.test.mjs': ES_TEST }, 'Add Spanish greeting');
  const final = commit(root, { 'test/greet.test.mjs': `${EN_TEST}test('english default', () => assert.equal(greet('Bo', 'en'), 'Hello, Bo!'));\n` }, 'fix: keep English as the default locale');
  return { root, base, final };
}
