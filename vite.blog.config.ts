import { defineConfig } from 'vite';

// The public blog's few static files (worker/blog-site.ts renders the pages),
// at fixed addresses so pages need no build manifest.
export default defineConfig({
  // Not the app's public/: its PDF.js data, icons and fonts are not used here.
  publicDir: 'src/blog/public',
  build: {
    outDir: 'dist-blog',
    target: 'es2022',
    // Fonts stay files: the blog's Content-Security-Policy refuses data: fonts.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { blog: 'src/blog/client.ts', 'blog-styles': 'src/blog/styles.ts' },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        // Fonts keep their names so that pages can preload them (worker/blog-site.ts).
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith('.css')) ? 'assets/blog.css' : 'assets/fonts/[name][extname]',
      },
    },
  },
});
