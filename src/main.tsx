import { createRoot } from 'react-dom/client';
import App from './App';
import { prepareProxy } from './proxy';
import { ProxyStatus } from './components/ProxySettings';
import { AppErrorBoundary, AppErrorScreen } from './components/AppErrorBoundary';
import './family-tokens.css';
import './styles.css';
import './projects.css';
import './encryption.css';
import './journals.css';
import './assistant.css';
import './themes.css';
import './shell.css';
import { prepareOfflineShell } from './offline-shell';
import { installSealedDownloads } from './sealed-download';

const root = createRoot(document.getElementById('root')!);
async function start() {
  if (import.meta.env.MODE === 'android') {
    (await import('./mobile')).installMobile();
    void prepareProxy();
  } else installSealedDownloads();
  root.render(
    <AppErrorBoundary>
      <App />
      <ProxyStatus />
    </AppErrorBoundary>,
  );
  void prepareOfflineShell().catch(() => {});
}
void start().catch((error: unknown) => root.render(<AppErrorScreen error={error} />));
