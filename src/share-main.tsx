import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import ShareWindow from './components/ShareWindow';
import { device } from './mobile';
import { prepareProxy } from './proxy';
import { ProxyStatus } from './components/ProxySettings';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './theme';
import './family-tokens.css';
import './styles.css';
import './projects.css';
import './encryption.css';
import './journals.css';
import './themes.css';
import './shell.css';
import './share.css';

// Android's share window: a page of its own over the sending app, without the
// notebook, its offline cache or the service worker.
if (Capacitor.isNativePlatform())
  void App.addListener('backButton', () => {
    const event = new CustomEvent('note:native-back', { cancelable: true });
    if (window.dispatchEvent(event)) void device.closeShare({}).catch(() => {});
  }).catch(() => {});
function start() {
  void prepareProxy();
  createRoot(document.getElementById('root')!).render(
    <AppErrorBoundary>
      <ShareWindow />
      <ProxyStatus />
    </AppErrorBoundary>,
  );
}
void start();
