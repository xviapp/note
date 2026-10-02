export function openLink(url: string) {
  const request = new CustomEvent('note:open-link', { detail: url, cancelable: true });
  if (window.dispatchEvent(request)) window.open(url, '_blank', 'noopener,noreferrer');
}
