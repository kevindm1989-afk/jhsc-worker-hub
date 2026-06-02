import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Vite config for apps/web.
//
// PWA configuration (Milestone 1.10 S2, ADR-0009 §3.9):
//   - strategies: 'injectManifest' — we ship a custom service-worker.ts
//     under apps/web/src/sync/ that handles /api/* interception (the
//     queueable-vs-require-online classification lives there).
//   - srcDir + filename point at our custom SW.
//   - registerType: 'autoUpdate' — vite-plugin-pwa generates the
//     registration code that shows a soft-update banner on next visit
//     (we don't silently swap controllers mid-session; ADR §3.9).
//   - manifest is generic per CLAUDE.md non-negotiable #1 (no workplace
//     name in the source). The display name "JHSC Worker Hub" + the
//     start_url and theme_color are static; the rep can rename the home-
//     screen icon themselves.

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sync',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      injectManifest: {
        // Precache the app shell + fonts; the SW file handles /api
        // interception separately.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Allow up to 5MB precache (the JS bundle + fonts + icons
        // comfortably fit; the inspection template + legal corpus
        // caches are populated at runtime via the sync drain).
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'JHSC Worker Hub',
        short_name: 'JHSC',
        description: 'Worker-side JHSC tool.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1e3a8a',
        background_color: '#ffffff',
        icons: [],
      },
      devOptions: {
        // Don't enable the SW during `vite dev` — the dev workflow is
        // network-first and the SW would interfere with HMR. Production
        // builds + Playwright e2e use the registered SW.
        enabled: false,
      },
    }),
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
