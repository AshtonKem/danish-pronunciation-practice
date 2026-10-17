/**
 * onnxruntime-web 1.30 ships only the "simd-threaded" wasm binary — compiled
 * with a shared `WebAssembly.Memory`, which needs `SharedArrayBuffer` to
 * instantiate at all, regardless of `numThreads` (see the workers' own
 * comments on that setting). `SharedArrayBuffer` is only handed to a page
 * that is itself cross-origin isolated.
 *
 * On a real server this app sets the COOP/COEP headers that isolation
 * requires (see vite.config.ts); on GitHub Pages, which can't set response
 * headers at all, `public/coi-serviceworker.js` sets them from a service
 * worker instead — a well-established technique. A crash reported right
 * after a model loaded, on any model regardless of size, identically on
 * WebGPU and WASM, on iOS, traced back to a real bug in both of those:
 * `Cross-Origin-Embedder-Policy: credentialless`, which neither has ever
 * supported setting on Safari or any iOS browser (all WebKit) -- so
 * `crossOriginIsolated` could never become true there no matter how
 * correctly the rest of the isolation setup ran. Both now set `require-corp`
 * instead, which WebKit does support. This check stays regardless: it turns
 * a missing SharedArrayBuffer into a clear error instead of however else it
 * might fail -- on some engines a failed shared-memory allocation surfaces
 * as an ordinary catchable exception, but iOS WebKit has been reported to
 * terminate the page outright for some invalid WASM memory operations
 * instead, which no amount of try/catch in this app's own code could turn
 * into a clean error message.
 */
export function requireCrossOriginIsolation(): void {
  if (self.crossOriginIsolated) return;
  throw new Error(
    'This page is not cross-origin isolated, so the browser will not grant it ' +
      'SharedArrayBuffer — which the on-device model runtime requires to start at ' +
      'all. If you are on the deployed site, this likely means the cross-origin ' +
      "isolation workaround (public/coi-serviceworker.js) isn't taking effect in " +
      'this browser; try a hard reload (so the service worker gets a fresh chance ' +
      'to register and reload the page itself), or try a different browser.',
  );
}
