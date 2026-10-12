// Persistent admission limits across missions and processes; no inference here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MISSION_ADMISSION = Object.freeze({ concurrent: 4, sessionsPerHour: 24, sessionsPerDay: 64, orchestratorsPerHour: 3, turnsPerHour: 48, turnsPerDay: 128 });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export class MissionBudget {
  constructor({ file = path.join(process.env.LOCALAPPDATA || os.homedir(), 'chats-dashboard', 'mission-budget.json'), now = Date.now } = {}) { this.file = file; this.now = now; }
  async mutate(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let acquired = false;
    for (let n = 0; n < 50; n++) {
      try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); acquired = true; break; }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try { const owner = JSON.parse(fs.readFileSync(lock, 'utf8')); if (!alive(owner.pid)) { fs.unlinkSync(lock); continue; } } catch { /* An incomplete lock stays closed. */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw Object.assign(Error('Usage control is busy. Try again.'), { status: 429 });
    try {
      let data = { version: 1, launches: [], active: [] };
      if (fs.existsSync(this.file)) {
        data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.launches) || !Array.isArray(data.active)) throw Error('Invalid usage record; no chats will be opened.');
      }
      const now = this.now();
      data.launches = data.launches.filter(entry => entry.at > now - 86400000);
      data.active = data.active.filter(entry => alive(entry.pid));
      const result = fn(data, now);
      const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, this.file);
      return result;
    } finally { fs.unlinkSync(lock); }
  }
  async reserve({ role = 'worker', sessionHandle } = {}) {
    const id = crypto.randomUUID();
    await this.mutate((data, now) => {
      const hour = data.launches.filter(entry => entry.at > now - 3600000);
      const newSession = !sessionHandle;
      const deny = detail => { throw Object.assign(Error(detail), { status: 429 }); };
      if (data.active.length >= MISSION_ADMISSION.concurrent) deny('Global limit: four simultaneous turns.');
      if (hour.length >= MISSION_ADMISSION.turnsPerHour || data.launches.length >= MISSION_ADMISSION.turnsPerDay) deny('Global turn limit reached; wait for the usage window to free capacity.');
      if (newSession && (hour.filter(entry => entry.newSession).length >= MISSION_ADMISSION.sessionsPerHour || data.launches.filter(entry => entry.newSession).length >= MISSION_ADMISSION.sessionsPerDay)) deny('Global chat limit reached; no more sessions will be opened.');
      if (role === 'orchestrator' && hour.filter(entry => entry.role === role).length >= MISSION_ADMISSION.orchestratorsPerHour) deny('Maximum three orchestrator launches per hour.');
      data.launches.push({ at: now, role, newSession }); data.active.push({ id, pid: process.pid, at: now });
    });
    let released = false;
    return { id, release: async () => { if (released) return; await this.mutate(data => { data.active = data.active.filter(entry => entry.id !== id); }); released = true; } };
  }
  async state() { return this.mutate((data, now) => ({ limits: MISSION_ADMISSION, active: data.active.length, turnsToday: data.launches.length, sessionsToday: data.launches.filter(entry => entry.newSession).length, sessionsHour: data.launches.filter(entry => entry.newSession && entry.at > now - 3600000).length })); }
}
