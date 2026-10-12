import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ACTIVATION = new RegExp(`^chats-dashboard-toast:(\\d{1,5})/(${UUID})/([0-9a-f]{64})$`, 'i');
export function notificationLink(id, port, secret) {
  const signature = crypto.createHmac('sha256', secret).update(`${port}/${id}`).digest('hex');
  const link = `chats-dashboard-toast:${port}/${id}/${signature}`;
  if (!parseNotificationLink(link)) throw new Error('Invalid notification target');
  return link;
}
export function parseNotificationLink(link) {
  const match = typeof link === 'string' && link.match(ACTIVATION);
  return match && Number(match[1]) > 0 && Number(match[1]) <= 65535
    ? { port: Number(match[1]), id: match[2], signature: match[3] } : null;
}
export function verifyNotificationLink(id, signature, port, secret) {
  const parsed = parseNotificationLink(`chats-dashboard-toast:${port}/${id}/${signature}`);
  if (!parsed) return false;
  const expected = parseNotificationLink(notificationLink(id, port, secret)).signature;
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./notify-windows.ps1', import.meta.url));
export async function windowsNotification({ title = '', text = '', url, test = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows notifications require Windows');
  // Base64 transports Unicode/data without interpolation into PowerShell code.
  const payload = Buffer.from(JSON.stringify({ title, text, url, test })).toString('base64');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Payload', payload], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const result = JSON.parse(stdout.trim());
  if (title && !result.accepted) throw new Error('Windows did not confirm the notification in its history');
  return result;
}
