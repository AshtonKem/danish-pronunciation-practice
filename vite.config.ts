import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const require_ = createRequire(import.meta.url);
// `onnxruntime-web` does not export ./package.json, but it does export each WASM
// sidecar by name — resolve one and take the directory it lives in.
const ORT_DIST = dirname(require_.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));

/**
 * The Piper voice runs on our own `onnxruntime-web` copy, which loads its WASM
 * sidecars at runtime from `ort.env.wasm.wasmPaths`. Rather than check 40+ MB of
 * binaries into `public/`, serve them straight out of `node_modules` in dev and
 * copy only what we actually reference into the bundle on build. Keeping the
 * sidecars same-origin also sidesteps the COEP restrictions below.
 */
function serveOrtRuntime(): Plugin {
  // ORT picks between four wasm "flavors" at runtime depending on what the
  // browser supports (plain, .jsep for WebGPU, .jspi, and .asyncify as the
  // fallback for browsers without WebAssembly JS Promise Integration) — which
  // one it wants isn't known ahead of time, so all of them need to be served.
  const wanted = (name: string) =>
    /^ort-wasm-simd-threaded(\.jsep|\.jspi|\.asyncify)?\.(wasm|mjs)$/.test(name);

  return {
    name: 'serve-ort-runtime',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = (req.url ?? '').replace(/^\/+/, '').split('?')[0];
        const file = join(ORT_DIST, name);
        if (!wanted(name) || !existsSync(file)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        createReadStream(file).pipe(res);
      });
    },
    async writeBundle(options) {
      const out = resolve(options.dir ?? 'dist', 'ort');
      await mkdir(out, { recursive: true });
      for (const name of await readdir(ORT_DIST)) {
        if (wanted(name)) await copyFile(join(ORT_DIST, name), join(out, name));
      }
    },
  };
}

// SharedArrayBuffer — and with it multi-threaded WASM inference — is only handed
// out to cross-origin-isolated pages. `credentialless` keeps model downloads from
// huggingface.co working, which plain `require-corp` would block.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react(), serveOrtRuntime()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  // Both runtimes ship prebuilt ESM with WASM sidecars; pre-bundling rewrites the
  // relative sidecar URLs and breaks them.
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  build: { target: 'es2022' },
});
