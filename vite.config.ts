import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './scripts/offline-shell';

export default defineConfig(({ mode }) => ({
  plugins: [react(), offlineShell()],
  css: {
    postcss: {
      plugins:
        mode === 'android'
          ? [{
              postcssPlugin: 'yejian-android-woff2',
              Declaration: {
                src(declaration) {
                  // WebView 125 supports WOFF2. Remove font fallbacks before
                  // Vite discovers their URLs and emits duplicate font assets.
                  const woff2 = declaration.value.match(/url\([^)]*\)\s*format\((["'])woff2\1\)/);
                  if (woff2) declaration.value = woff2[0];
                },
              },
            }]
          : [],
    },
  },
  resolve: {
    // Android WebView updates separately from the OS. Ship PDF.js's supported
    // compatibility build, including its matching worker, inside the APK.
    alias:
      mode === 'android'
        ? [
            { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
            { find: 'pdfjs-dist/build', replacement: 'pdfjs-dist/legacy/build' },
          ]
        : [],
  },
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.NOTE_WORKER_PORT || 8787}` } },
  build: {
    chunkSizeWarningLimit: 900,
    outDir: mode === 'android' ? 'dist-android' : 'dist',
    // share.html is Android's share window, a page of its own over the sending app;
    // window.html the floating 今日记 and 问青藜 windows opened from the launcher.
    rollupOptions: { input: { main: 'index.html', share: 'share.html', window: 'window.html' } },
  },
}));
