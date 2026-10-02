// field-sw.js — service worker for the FIELD PWA.
// Only touches FIELD's own shell + the EXECUTE task list; every other Valinor
// request passes straight through to the network.
const CACHE = 'field-v1';
const SHELL = ['/field.html', '/hub-client.js', '/field.webmanifest',
  '/icons/field-192.png', '/icons/field-512.png', '/icons/field-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('field-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, cache as the offline fallback. Cached task lists are tagged with
// x-field-cache so the page can say it's showing stale data.
async function networkFirst(req, tagStale) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (!hit) throw err;
    if (!tagStale) return hit;
    const h = new Headers(hit.headers);
    h.set('x-field-cache', '1');
    return new Response(await hit.blob(), { status: hit.status, headers: h });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/api/execute') { e.respondWith(networkFirst(req, true)); return; }
  if (SHELL.includes(url.pathname) || url.pathname === '/field') { e.respondWith(networkFirst(req, false)); return; }
});
