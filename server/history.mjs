import { Worker } from 'node:worker_threads';

export class HistoryIndex {
  constructor(home, file, workerName = './history-worker.mjs') { this.home = home; this.file = file; this.workerName = workerName; this.state = { phase: 'idle', files: 0, total: 0, bytes: 0, messages: 0 }; }
  start() {
    if (this.worker) return;
    this.worker = new Worker(new URL(this.workerName, import.meta.url), { workerData: { home: this.home, file: this.file } });
    this.worker.on('message', message => {
      if (message.state) this.state = message.state;
      if (message.request) {
        const pending = this.pending.get(message.request);
        this.pending.delete(message.request);
        if (message.error) pending?.reject(new Error(message.error));
        else pending?.resolve(message.result);
      }
    });
    this.worker.on('error', error => this.failed(error));
    this.worker.on('exit', code => { if (code) this.failed(new Error('History worker stopped')); });
  }
  pending = new Map();
  sequence = 0;
  failed(error) {
    this.state = { ...this.state, phase: 'error', error: error.message };
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear(); this.worker = null;
  }
  request(action, data = {}) {
    this.start();
    const request = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(request, { resolve, reject }); this.worker.postMessage({ request, action, ...data }); });
  }
  close() { this.worker?.terminate(); }
}
