import { defineConfig } from 'vite';

// In dev the API runs on 8787 and we proxy /v1 to it, so the browser only
// ever talks to one origin and cookies behave. In production either serve
// the built folder from the API (NIGHTSHIFT_STATIC) or set VITE_API_URL.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
      '/health': 'http://localhost:8787',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
