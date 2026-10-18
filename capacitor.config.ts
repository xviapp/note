import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.xvi.note',
  appName: '页间',
  webDir: 'dist-android',
  // MainActivity sets the native canvas from the saved/system theme before
  // the first frame; a fixed light background flashes under the splash exit.
  loggingBehavior: 'debug',
  // The APK serves its bundled UI at our HTTPS origin. MainActivity lets
  // /api requests reach the real server, preserving cookies, uploads and SSE.
  server: {
    hostname: 'iyi.li',
    androidScheme: 'https',
    errorPath: 'android-webview.html',
  },
  android: { minWebViewVersion: 125 },
  plugins: {
    SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'contain' },
  },
};

export default config;
