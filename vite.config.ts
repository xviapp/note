import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './scripts/offline-shell';

export default defineConfig(({ mode }) => ({
  plugins: [react(), offlineShell()],
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
  build: { chunkSizeWarningLimit: 900, outDir: mode === 'android' ? 'dist-android' : 'dist' },
}));
