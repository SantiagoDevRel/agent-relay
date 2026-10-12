// Native protocol activation: focus the existing chat without opening a browser.
// The signed URI carries an ID only; commands, titles and paths stay server-side.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseNotificationLink } from './notifications.mjs';

export async function activateNotification(uri, { request = fetch, open = openFallback } = {}) {
  const target = parseNotificationLink(uri);
  if (!target) throw new Error('Invalid notification link');
  const base = `http://127.0.0.1:${target.port}`;
  let focused = false;
  try {
    const ping = await request(base + '/api/ping', { signal: AbortSignal.timeout(3000) });
    if (!ping.ok || (await ping.json()).app !== 'chats-dashboard') throw new Error('Dashboard unavailable');
    const page = await request(base + '/', { signal: AbortSignal.timeout(3000) });
    const token = (await page.text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];
    if (!page.ok || !token) throw new Error('Dashboard token unavailable');
    const response = await request(base + '/api/notification-click', {
      method: 'POST', signal: AbortSignal.timeout(25_000),
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Chats-Token': token },
      body: JSON.stringify({ id: target.id, signature: target.signature }),
    });
    focused = response.ok && (await response.json()).focused === true;
  } catch { /* A closed tab, expired server signature or unavailable server uses the card. */ }
  if (!focused) await open(`${base}/#chat-${target.id}`);
  return { focused, fallback: !focused };
}
function openFallback(url) {
  return new Promise((resolve, reject) => execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url],
    { windowsHide: true, timeout: 10_000 }, error => error ? reject(error) : resolve()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  activateNotification(process.argv[2]).catch(() => { process.exitCode = 1; });
}
