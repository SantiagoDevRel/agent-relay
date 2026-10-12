// Lets the installed app open while the dashboard server is off. Page loads go
// to the network; if it is unreachable they get a cached copy of the app built
// without a token (/shell.html), which shows "Offline" and a "Turn on"
// button. /api/* is never intercepted or cached, so no chat data is stored.
const CACHE = 'chats-shell';
const SHELL = '/shell.html';

async function refreshShell() {
  const response = await fetch(SHELL, { cache: 'no-store' });
  if (!response.ok) return;
  const html = await response.clone().text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/(?:assets|icons)\/[^"]+)"/g)].map(match => match[1]))];
  const cache = await caches.open(CACHE);
  await cache.addAll(assets);
  await cache.put(SHELL, response);
  // Forget the files of older builds.
  const keep = new Set([SHELL, ...assets].map(path => new URL(path, self.location.origin).href));
  for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
}

self.addEventListener('install', event => {
  event.waitUntil(refreshShell().catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then(response => { event.waitUntil(refreshShell().catch(() => {})); return response; })
      .catch(async () => (await caches.match(SHELL)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) || Response.error()));
  }
});
