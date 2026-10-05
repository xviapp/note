import { useEffect, type RefObject } from 'react';

// Qingli renders into this element. A full-screen view (a modal dialog, which
// sits above the page) moves it inside itself so Qingli shows above the view
// instead of beneath it, and puts it back when it closes. Moving the element
// keeps the rendered tree, so the conversation, draft and quotes carry over.
let host: HTMLElement | null = null;
export function assistantHost() {
  if (!host) {
    host = document.createElement('div');
    host.className = 'assistant-host';
    document.body.appendChild(host);
  }
  return host;
}
export function useAssistantHost(view: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const target = assistantHost();
    element.appendChild(target);
    return () => {
      document.body.appendChild(target);
    };
  }, [view]);
}
