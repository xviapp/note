// Android's Back key should dismiss the current reading surface before navigating.
export function dismissReadingOverlay(): boolean {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  const root = dialog ?? document;
  const target = root.querySelector<HTMLElement>(
    '.selection-toolbar, .translation-window, .pdf-outline:not([hidden])',
  );
  if (target) {
    if (target.matches('.pdf-outline'))
      target.querySelector<HTMLButtonElement>('.pdf-outline-heading button')?.click();
    else
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    return true;
  }
  if (dialog) {
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    return true;
  }
  const menu = document.querySelector<HTMLDetailsElement>('details.node-menu[open]');
  if (menu) {
    menu.open = false;
    return true;
  }
  const assistant = document.querySelector<HTMLElement>('.assistant-panel:not([hidden])');
  if (assistant) {
    assistant.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    return true;
  }
  return false;
}
