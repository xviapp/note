import { createRoot } from 'react-dom/client';
import App from './App';
import './family-tokens.css';
import './styles.css';
import './assistant.css';
import './themes.css';
import './shell.css';
import { prepareOfflineShell } from './offline-shell';
async function start() {
  if (import.meta.env.MODE === 'android') (await import('./mobile')).installMobile();
  createRoot(document.getElementById('root')!).render(<App />);
  void prepareOfflineShell().catch(() => {});
}
void start();
