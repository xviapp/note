import { SEALED_PREFIX, sealedSize } from './encryption';

// Quick clips (随手记): short text kept outside the note tree, newest first.
export const CLIP_CHARS = 10_000;
// Unpinned clips past this count are dropped, oldest first, by the periodic cleanup.
export const CLIP_KEEP = 500;
export const CLIP_PINNED = 50;
export const CLIP_PAGE = 50;
// A sealed clip: the prefix and the base64url of the sealed UTF-8 text.
export const CLIP_SEALED_CHARS =
  SEALED_PREFIX.length + Math.ceil((sealedSize(CLIP_CHARS * 3) * 4) / 3);
// A clip may carry one image.
export const CLIP_IMAGE_BYTES = 10_000_000;
export const CLIP_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|avif)$/;
// A clip written offline keeps its time, within reason.
export const CLIP_BACKDATE = 30 * 86400_000;

export interface Clip {
  id: string;
  // Opened on the device; empty while its key is locked, or for an image alone.
  text: string;
  key_id: string | null;
  source_id: string | null;
  // The source page's title while it exists outside the trash.
  source_title: string | null;
  pinned: boolean;
  created_at: number;
  // The image, sealed with `key_id` when there is one.
  file: { id: string; name: string; mime: string; size: number; key_id: string | null } | null;
}
export interface ClipList {
  // On the first page only; later pages carry none.
  pinned: Clip[];
  items: Clip[];
  // Cursor for the next page of unpinned clips, null at the end.
  next: string | null;
  // The key new clips are sealed with.
  keyId: string | null;
}
