// Static hosts like GitHub Pages cannot send the cross-origin isolation headers that SharedArrayBuffer
// (and with it multi-threaded rendering) needs. This service worker adds them to same-origin responses.
// The cpu3d server sends the headers itself, so it is only registered when the page is not isolated.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (new URL(r.url).origin !== self.location.origin || (r.cache === 'only-if-cached' && r.mode !== 'same-origin')) return;
  e.respondWith(fetch(r).then((res) => {
    if (!res || res.status === 0 || res.type === 'opaque') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
