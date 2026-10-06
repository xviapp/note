import { sealedFile } from './encryption';
import { fileBlob } from './offline-cache';

// A sealed file downloads as ciphertext; links to one are saved decrypted
// instead (the Android shell does the same in mobile.ts).
export function sealedFileId(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    const id =
      url.origin === location.origin ? url.pathname.match(/^\/api\/files\/([\w-]+)$/)?.[1] : null;
    return id && sealedFile(id) ? id : null;
  } catch {
    return null;
  }
}
export async function saveSealed(id: string, name = '') {
  const blob = await fileBlob(id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name || sealedFile(id)?.name || '页间文件';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export function installSealedDownloads() {
  document.addEventListener(
    'click',
    (event) => {
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      const id = anchor ? sealedFileId(anchor.href) : null;
      if (!anchor || !id) return;
      event.preventDefault();
      event.stopPropagation();
      void saveSealed(id, anchor.download).catch((error: Error) => window.alert(error.message));
    },
    true,
  );
}
