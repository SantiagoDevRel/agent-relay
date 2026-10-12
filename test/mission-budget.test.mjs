import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionBudget } from '../server/mission-budget.mjs';

test('admission is durable across missions, limits concurrency, and resumes reuse sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-budget-'));
  let now = Date.now(); const opts = { file: path.join(dir, 'budget.json'), now: () => now };
  try {
    const a = new MissionBudget(opts), b = new MissionBudget(opts);
    const slots = await Promise.all([a.reserve(), b.reserve(), a.reserve(), b.reserve()]);
    await assert.rejects(a.reserve(), /four/);
    await Promise.all(slots.map(slot => slot.release()));
    for (let n = 0; n < 20; n++) await (await b.reserve()).release();
    await assert.rejects(new MissionBudget(opts).reserve(), /chat limit/);
    await (await a.reserve({ sessionHandle: 'existing-session' })).release();
    assert.equal((await b.state()).sessionsHour, 24);
    now += 3600001;
    await (await a.reserve()).release();
    assert.equal((await b.state()).sessionsToday, 25);
    assert.equal((await b.state()).active, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt admission data fails closed and native orchestrator openings are bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-budget-'));
  const file = path.join(dir, 'budget.json'); const budget = new MissionBudget({ file });
  try {
    for (let n = 0; n < 3; n++) await (await budget.reserve({ role: 'orchestrator' })).release();
    await assert.rejects(budget.reserve({ role: 'orchestrator' }), /three/);
    fs.writeFileSync(file, '{}');
    await assert.rejects(budget.reserve(), /Invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
