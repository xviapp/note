import { saveSealed, sealedFileId } from './sealed-download';

export function openLink(url: string) {
  // A sealed file is saved decrypted (the Android shell handles it itself).
  const sealed = sealedFileId(url);
  if (sealed && import.meta.env.MODE !== 'android') {
    void saveSealed(sealed).catch((error: Error) => window.alert(error.message));
    return;
  }
  const request = new CustomEvent('note:open-link', { detail: url, cancelable: true });
  if (window.dispatchEvent(request)) window.open(url, '_blank', 'noopener,noreferrer');
}
