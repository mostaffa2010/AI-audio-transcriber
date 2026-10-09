/* FlowMate Transcriber service worker
   - precaches the app shell so it opens offline
   - stale-while-revalidate for same-origin GETs
   - receives audio shared from other apps (Web Share Target) */
const VERSION = 'v2';
const CACHE = 'flowmate-shell-' + VERSION;
const SHARE_CACHE = 'flowmate-share';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('flowmate-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Audio shared into the app from the system share sheet
  if (req.method === 'POST' && url.origin === location.origin && url.searchParams.has('share-target')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('audio');
        if (file && typeof file !== 'string') {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put('shared-audio', new Response(file, {
            headers: {
              'Content-Type': file.type || 'audio/mpeg',
              'X-File-Name': encodeURIComponent(file.name || 'shared-audio')
            }
          }));
        }
      } catch (_) { /* fall through to the redirect */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== location.origin) return; // never touch the Groq API

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});
