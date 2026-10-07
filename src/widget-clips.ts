import { api } from './api';
import { sealString } from './encryption';
import { subscribeKeys } from './keyring';
import { onClipsSent } from './clips';

// Native captures stay in the device-encrypted outbox until the server confirms
// them. The background job handles plain clips; this path can also use an
// unlocked library key. Both paths use the same id, including after a lost reply.
let running: Promise<void> | null = null;
export function flushWidgetClips(): Promise<void> {
  if (running) return running;
  running = send().finally(() => { running = null; });
  return running;
}
async function send() {
  try {
    const { device } = await import('./mobile');
    const { items } = await device.pendingWidgetClips();
    if (!items.length) return;
    const { keyId } = await api<{ keyId: string | null }>('/api/clips/key');
    for (const item of items) {
      const text = keyId ? await sealString(keyId, item.text) : item.text;
      await api('/api/clips', 'POST', { id: item.id, text, createdAt: item.createdAt }, item.id);
      await device.removeWidgetClip({ id: item.id });
    }
    window.dispatchEvent(new Event('note:widget-clips-sent'));
  } catch {
    // Offline, signed out, locked or changed encryption: keep the native copy.
  }
}
export function watchWidgetClips() {
  const flush = () => void flushWidgetClips();
  flush();
  window.addEventListener('focus', flush);
  window.addEventListener('note:reconnected', flush);
  const unkeys = subscribeKeys(flush);
  const unsent = onClipsSent(flush);
  return () => {
    window.removeEventListener('focus', flush);
    window.removeEventListener('note:reconnected', flush);
    unkeys(); unsent();
  };
}
