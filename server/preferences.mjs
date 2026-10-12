import fs from 'node:fs';
import path from 'node:path';

export class Preferences {
  constructor(file) {
    this.file = file;
    this.data = { notifications: false, chats: {}, templates: [], assistance: { handoffTokens: 300000, handoffPercent: 80 } };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  get(id) { return this.data.chats[id] || { favorite: false, note: '' }; }
  favorites() { return new Set(Object.keys(this.data.chats).filter(id => this.get(id).favorite)); }
  save(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.data = next;
  }
  chat(id, patch) {
    const value = { ...this.get(id), ...patch };
    this.save({ ...this.data, chats: { ...this.data.chats, [id]: value } });
    return value;
  }
  notifications(enabled) { this.save({ ...this.data, notifications: enabled }); }
  assistance(patch) { this.save({ ...this.data, assistance: { ...this.data.assistance, ...patch } }); return this.data.assistance; }
  template(template) {
    const templates = this.data.templates || [];
    const next = templates.some(t=>t.id===template.id) ? templates.map(t=>t.id===template.id?template:t) : [...templates,template];
    if(next.length>100)throw Error('Template limit reached');
    this.save({...this.data,templates:next});return next;
  }
}

// Seed on startup/enable. Never notify for old history, automated lanes, normal
// exits or an unreadable collector. Only observed state transitions count.
export class NotificationTransitions {
  previous = new Map();
  seeded = false;
  reset() { this.seeded = false; this.previous.clear(); }
  update(chats) {
    const events = [];
    // Git/CI/collision changes belong to dashboard attention, not Windows toasts.
    // A toast means this interactive chat has finished its turn or was cut.
    for (const chat of chats) {
      const prev = this.previous.get(chat.id);
      if (this.seeded && prev && !chat.automated) {
        if (prev.state === 'working' && chat.state === 'waiting' && chat.alive) events.push({ ...chat, notificationKind: 'turn' });
        else if (prev.alive && ['working', 'waiting'].includes(prev.state) && chat.state === 'cut') events.push({ ...chat, notificationKind: 'cut' });
      }
    }
    this.previous = new Map(chats.map(chat => [chat.id, chat]));
    this.seeded = true;
    return events;
  }
}
