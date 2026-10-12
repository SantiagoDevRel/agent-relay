import { Worker } from 'node:worker_threads';

export function deliveryAttention(chat, delivery, now, productionSince) {
  const reasons = [];
  if (delivery.state !== 'attributed') return reasons;
  for (const lane of delivery.lanes) {
    if (lane.ci?.state === 'failure') reasons.push('CI failed');
    if (chat.state !== 'working' && lane.committed > 0 && lane.onMain === false) reasons.push('Turn finished with commits outside main');
    if (lane.production === true && lane.verification?.state !== 'verified' && now - productionSince >= 30 * 60000) reasons.push('Production check not reported within 30 minutes');
    if (lane.collisions?.length) reasons.push('Code collision: ' + lane.collisions.join(', '));
  }
  return [...new Set(reasons)];
}

// A background worker owns all transcript/Git/GitHub work. The 4 s loop only posts inputs.
export class DeliveryCollector {
  constructor({ onChange = () => {}, disabled = process.env.CHATS_DELIVERY_DISABLED === '1' } = {}) { this.onChange = onChange; this.disabled = disabled; this.values = new Map(); this.lastAt = -Infinity; this.busy = false; this.error = ''; this.productionSince = new Map(); this.progress = null; }
  refresh(chats, now = Date.now()) {
    if (this.disabled || this.busy || now - this.lastAt < 30000) return;
    this.lastAt = now; this.busy = true;
    if (!this.worker) {
      this.worker = new Worker(new URL('./delivery-worker.mjs', import.meta.url));
      this.worker.on('message', result => {
        if (result.progress) this.progress = result.progress;
        if (result.values) { this.values = new Map(result.values); this.error = ''; }
        if (result.done) this.busy = false;
        if (result.error) { this.error = result.error; this.busy = false; }
        if (result.values || result.done || result.error) this.onChange();
      });
      this.worker.on('error', () => { this.error = 'Delivery collector unavailable'; this.busy = false; this.worker = null; this.onChange(); });
    }
    this.worker.postMessage({ chats: chats.map(({ id, tool, cwd, file, alive, automated, state }) => ({ id, tool, cwd, file, alive, automated, state })) });
  }
  forChat(chat, now = Date.now()) {
    const value = this.values.get(chat.id);
    if (!value) return { state: 'unknown', lanes: [], coverage: 'pending', attention: [], error: this.error };
    const key = chat.id + ':' + value.lanes.map(l => l.productionSha || '').join(',');
    if (value.lanes.some(l => l.production === true) && !this.productionSince.has(key)) this.productionSince.set(key, now);
    const fresh = now - value.checkedAt < 180000;
    return { ...value, stale: !fresh, attention: fresh ? deliveryAttention(chat, value, now, this.productionSince.get(key) || now) : [], error: this.error || value.error };
  }
  close() { void this.worker?.terminate(); this.worker = null; }
  publicState() { return { busy: this.busy, error: this.error, progress: this.progress }; }
}
