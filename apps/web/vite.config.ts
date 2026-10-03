import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { wasm } from '@rollup/plugin-wasm';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import inject from '@rollup/plugin-inject';
import topLevelAwait from 'vite-plugin-top-level-await';
import { parseSecurityHeaders, previewHeaders } from './src/app/securityHeaders';

/**
 * matrix-js-sdk's Rust/WASM crypto stack (@matrix-org/matrix-sdk-crypto-wasm) needs its .wasm
 * file served with the right MIME type in dev — Vite's default static serving doesn't do this
 * for files inside node_modules/.vite/deps. Ported from cinny-voice's vite.config.js, which hit
 * this same issue.
 */
function serveMatrixSdkCryptoWasm(wasmRequestPath: string): Plugin {
  return {
    name: 'serve-matrix-sdk-crypto-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === wasmRequestPath) {
          const resolvedPath = path.join(
            path.resolve(),
            '/node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm'
          );
          if (fs.existsSync(resolvedPath)) {
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(resolvedPath).pipe(res);
          } else {
            res.writeHead(404);
            res.end('File not found');
          }
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  appType: 'spa',
  server: {
    port: 8080,
    host: true,
  },
  // The production build under production's headers (deploy/security-headers.conf), so the
  // end-to-end tests catch anything the Content-Security-Policy would block. Not the dev server,
  // whose hot reloading needs inline scripts.
  preview: {
    headers: previewHeaders(parseSecurityHeaders(fs.readFileSync(path.resolve('deploy/security-headers.conf'), 'utf8'))),
  },
  plugins: [
    serveMatrixSdkCryptoWasm('/node_modules/.vite/deps/pkg/matrix_sdk_crypto_wasm_bg.wasm'),
    topLevelAwait({
      promiseExportName: '__tla',
      promiseImportName: (i) => `__tla_${i}`,
    }),
    wasm(),
    react(),
  ],
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
      plugins: [
        NodeGlobalsPolyfillPlugin({
          process: false,
          buffer: true,
        }),
      ],
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      plugins: [inject({ Buffer: ['buffer', 'Buffer'] })],
    },
  },
});
