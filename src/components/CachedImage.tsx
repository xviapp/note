import { useEffect, useState, type ComponentProps } from 'react';
import { fileBlob } from '../offline-cache';

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
export function CachedImage({ src = '', ...props }: ComponentProps<'img'>) {
  const url = useFileImage(src);
  return <img {...props} src={url} />;
}
