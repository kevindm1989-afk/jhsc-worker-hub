import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for apps/web.

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    react(),
    // TODO: Milestone 1.10 — add vite-plugin-pwa here for offline-first PWA
    // support (service worker, manifest, install prompt, app badging). The
    // 1.x line is required for Vite 7 peer compatibility.
  ],
  server: {
    port: 5173,
    strictPort: false,
    host: '127.0.0.1',
    // Forward /api/* to the API server so the SPA's fetch calls reach
    // the Hono routes during dev (and during Playwright e2e runs).
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 3001}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
