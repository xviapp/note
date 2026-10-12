import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { device, installMobile, type LaunchAction } from './mobile';
import { prepareProxy } from './proxy';
import { ProxyStatus } from './components/ProxySettings';
import { AssistantSheet, JournalWindow } from './components/FloatingWindows';
import './theme';
import './family-tokens.css';
import './styles.css';
import './encryption.css';
import './journals.css';
import './assistant.css';
import './themes.css';
import './shell.css';
import './share.css';

// Android's floating windows from launcher shortcuts (今日记, 问青藜): one
// tool over whatever app is open, without the notebook or its offline cache.
async function start() {
  installMobile();
  void prepareProxy();
  let kind: LaunchAction | null = null;
  if (Capacitor.isNativePlatform()) kind = (await device.takeLaunch().catch(() => ({ action: null }))).action;
  else kind = location.hash === '#assistant' ? 'assistant' : 'journal';
  createRoot(document.getElementById('root')!).render(
    <>
      {kind === 'assistant' ? <AssistantSheet /> : <JournalWindow />}
      <ProxyStatus />
    </>,
  );
}
void start();
