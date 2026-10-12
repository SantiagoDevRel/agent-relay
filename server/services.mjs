import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SUMMARY_URL, SUMMARY_MODEL } from './summary.mjs';

const exec = promisify(execFile);
const tool = process.env.CHATS_DGX_PROBE;
export function parseDgx(text) {
  const gpu = text.match(/GPU:\s*(\d+(?:\.\d+)?)% util\s*·\s*(\d+(?:\.\d+)?)°C/);
  const ram = text.match(/RAM unificada:\s*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) GB usada/);
  const comfy = text.match(/ComfyUI service:\s*(\S+)/)?.[1];
  // Read actual heavy-process lines; a lock alone does not prove a job is alive.
  const services = [];
  if (comfy === 'active') services.push('ComfyUI');
  if (/pid\s*\d+[^\n]*whisper[^\n]*python|pid\s*\d+[^\n]*python[^\n]*whisper/i.test(text)) services.push('Whisper');
  const samples = text.split('CPU_STAT_BEGIN')[1]?.match(/^cpu\s+[\d ]+$/gm);
  return { verdict: text.match(/VERDICT:\s*(FREE|LIGHT|BUSY)/)?.[1] || 'UNKNOWN',
    percent: gpu ? Number(gpu[1]) : null, temperature: gpu ? Number(gpu[2]) : null,
    cpuPercent: samples?.length === 2 ? cpuPercent(samples[0], samples[1]) : null,
    ram: ram ? { used: Number(ram[1]), total: Number(ram[2]) } : null,
    services, servicesKnown: Boolean(comfy), detail: text.trim().slice(0, 2500) };
}
export function cpuPercent(before, after) {
  const read = line => line.trim().split(/\s+/).slice(1, 9).map(Number);
  const a = read(before), b = read(after);
  if (a.length !== 8 || b.length !== 8 || [...a, ...b].some(n => !Number.isFinite(n))) return null;
  // /proc/stat: guest is already included in user/nice; idle includes iowait.
  // https://docs.kernel.org/filesystems/proc.html
  const delta = b.map((n, i) => n - a[i]);
  const total = delta.reduce((sum, n) => sum + n, 0);
  if (total <= 0 || delta.some(n => n < 0)) return null;
  return Math.round(1000 * (1 - (delta[3] + delta[4]) / total)) / 10;
}
export class Services {
  cached = null;
  pending = null;
  async status() {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }
  async read() {
    const json = async endpoint => {
      const r = await fetch(SUMMARY_URL + endpoint, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const [tags, loaded, gpu] = await Promise.allSettled([
      json('/api/tags'), json('/api/ps'),
      // Fake/custom Ollama servers used by tests must not probe the real DGX.
      !tool ? Promise.reject(new Error('No optional GPU probe configured'))
        : exec(process.execPath, [tool, 'run', "spark-gpu && printf '\\nCPU_STAT_BEGIN\\n' && head -n 1 /proc/stat && sleep 0.25 && head -n 1 /proc/stat"],
          { env: { ...process.env, DGX_RUN: '1', DGX_TIMEOUT: '12' }, windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 }),
    ]);
    this.cached = { at: Date.now(), available: tags.status === 'fulfilled', model: SUMMARY_MODEL,
      installed: tags.status === 'fulfilled' && tags.value.models?.some(m => m.name === SUMMARY_MODEL),
      loaded: loaded.status === 'fulfilled' ? loaded.value.models?.map(m => ({ name: m.name, sizeVram: m.size_vram })) || [] : [],
      loadedKnown: loaded.status === 'fulfilled',
      gpu: parseDgx(gpu.status === 'fulfilled' ? gpu.value.stdout : 'DGX load could not be verified.') };
    return this.cached;
  }
}
