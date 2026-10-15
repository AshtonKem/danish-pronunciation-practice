// Cross-origin isolation shim for hosts that can't set response headers
// (GitHub Pages has no server config of its own). The browser only hands out
// SharedArrayBuffer to a page whose own response carried
// Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy — headers a
// service worker's synthesized response is just as able to set as a real
// server. See index.html for the registration/reload side of this.
//
// Only same-origin requests are touched. Cross-origin fetches (model weights
// from huggingface.co) are passed through untouched: COEP's `credentialless`
// mode, which this app declares, strips credentials from the request rather
// than requiring the response to opt in via Cross-Origin-Resource-Policy, so
// it needs no cooperation from those responses at all. Rewriting them would
// only risk breaking range requests or caching for no benefit.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then((response) => {
      if (response.status !== 0 && response.type === 'opaque') return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
