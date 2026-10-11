import type { Clip } from '../shared/clips';
import { fileBlob } from './offline-cache';

// The image of a clip as a file of its own, decrypted here when sealed.
export async function clipFile(file: NonNullable<Clip['file']>) {
  const blob = await fileBlob(file.id);
  return new File([blob], file.name, { type: file.mime });
}
// The clipboard takes PNG everywhere, so other types are drawn into one first.
export async function copyImage(file: NonNullable<Clip['file']>) {
  let blob: Blob = await fileBlob(file.id);
  if (file.mime !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error())), 'image/png'),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
