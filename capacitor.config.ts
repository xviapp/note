import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.xvi.note',
  appName: '页间',
  webDir: 'dist-android',
  backgroundColor: '#fcfdfb',
  loggingBehavior: 'debug',
  // The APK serves its bundled UI at our HTTPS origin. MainActivity lets
  // /api requests reach the real server, preserving cookies, uploads and SSE.
  server: {
    hostname: 'note.xvi.app',
    androidScheme: 'https',
    errorPath: 'android-webview.html',
  },
  android: { minWebViewVersion: 125 },
  plugins: {
    SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'contain' },
  },
};

export default config;
