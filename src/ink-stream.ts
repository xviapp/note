import type { ChatEvent } from '../shared/assistant';

// Buffer presentation only; the request and server-side persistence are unchanged.
export function inkStream(onEvent: (event: ChatEvent) => void) {
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const content = pending;
    pending = '';
    onEvent({ type: 'delta', content });
  };
  return {
    flush,
    emit(event: ChatEvent) {
      if (event.type !== 'delta') {
        flush();
        onEvent(event);
        return;
      }
      pending += event.content;
      if (pending.includes('\n\n')) flush();
      else timer ??= setTimeout(flush, 1500);
    },
  };
}
