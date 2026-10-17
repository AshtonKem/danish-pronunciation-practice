// Cross-origin isolation shim for hosts that can't set response headers
// (GitHub Pages has no server config of its own). The browser only hands out
// SharedArrayBuffer to a page whose own response carried
// Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy — headers a
// service worker's synthesized response is just as able to set as a real
// server. See index.html for the registration/reload side of this.
//
// `require-corp`, not `credentialless`: Safari and every iOS browser (all
// WebKit) have never supported `credentialless`, in any version, which means
// crossOriginIsolated never becomes true there no matter how this is set up.
// `require-corp` doesn't need huggingface.co's cooperation either: a
// cross-origin fetch() in the default 'cors' mode that gets back a valid
// Access-Control-Allow-Origin — which it already sends — satisfies
// require-corp on its own, no Cross-Origin-Resource-Policy header needed
// from the far side.
//
// Only same-origin requests are touched regardless; cross-origin ones are
// passed through untouched, since rewriting them risks breaking range
// requests or caching for no benefit — require-corp's requirement is already
// met by the CORS response alone.

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
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
