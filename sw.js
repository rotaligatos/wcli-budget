/* Costline service worker: the app opens fast and still loads with a weak connection.
   Data (Supabase) is never cached; the app page is network-first so updates arrive at once. */
const VER = 'costline-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest?v=2', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || /supabase\.co$/.test(u.hostname)) return;
  if (r.mode === 'navigate' || (u.origin === location.origin && /\/(index\.html)?$/.test(u.pathname))) {
    e.respondWith(fetch(r, { cache:'no-cache' }).then(res => { const c = res.clone(); caches.open(VER).then(x => x.put('./index.html', c)); return res; }).catch(() => caches.match('./index.html')));
    return;
  }
  if (u.origin === location.origin || /(jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com)$/.test(u.hostname)) {
    e.respondWith(caches.match(r).then(hit => { const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(VER).then(x => x.put(r, c)); } return res; }).catch(() => hit); return hit || net; }));
  }
});
