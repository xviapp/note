import { useEffect, useState, type ComponentProps } from 'react';
import { fileBlob, iconImage, loadedIcon } from '../offline-cache';

export function internalFileId(src: string) {
  try {
    const url = new URL(src, location.origin);
    return url.origin === location.origin
      ? url.pathname.match(/^\/api\/files\/([\w-]+)$/)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}
export function useFileImage(src: string) {
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  const id = internalFileId(src);
  useEffect(() => {
    if (!id) return;
    let active = true;
    let url: string | undefined;
    void fileBlob(id)
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setResolved({ source: src, url });
      })
      .catch(() => {});
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, id]);
  return id ? (resolved?.source === src ? resolved.url : undefined) : src;
}
// Small immutable images, such as folder icons, stay loaded for the session and
// are kept on this device, so returning to a list does not fetch them again.
function useIconImage(src: string) {
  const id = internalFileId(src);
  const known = id ? loadedIcon(id) : undefined;
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  useEffect(() => {
    if (!id || known) return;
    let active = true;
    void iconImage(id)
      .then((url) => {
        if (active) setResolved({ source: src, url });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [src, id, known]);
  return id ? (known ?? (resolved?.source === src ? resolved.url : undefined)) : src;
}
function FileImage({ src, ...props }: ComponentProps<'img'> & { src: string }) {
  return <img {...props} src={useFileImage(src)} />;
}
function IconImage({ src, ...props }: ComponentProps<'img'> & { src: string }) {
  return <img {...props} src={useIconImage(src)} />;
}
export function CachedImage({
  src = '',
  icon = false,
  ...props
}: ComponentProps<'img'> & { icon?: boolean }) {
  return icon ? <IconImage {...props} src={src} /> : <FileImage {...props} src={src} />;
}
