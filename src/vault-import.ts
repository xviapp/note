import { Capacitor } from '@capacitor/core';
import { ApiError, api, upload } from './api';
import { LockedError } from './encryption';
import { rewriteLinks } from './import-links';
import type { FileInfo } from '../shared/types';

// Importing a folder of notes (an Obsidian or Typora vault) from this device;
// see docs/import.md. planImport() decides what each file becomes from paths
// alone; runImport() uploads the files and creates the entries. A directory
// goes into a new folder, so an import never mixes with existing notes.

export type ImportKind = 'folder' | 'markdown' | 'text' | 'pdf' | 'image';
export interface ImportSource {
  // Relative path with '/' separators, as the browser gives it.
  path: string;
  size: number;
}
export interface ImportItem<T extends ImportSource> {
  // Where it was in the vault (a folder's own path); unique in the plan.
  path: string;
  title: string;
  kind: ImportKind;
  // The item it goes into, or null for the top of the import.
  parent: string | null;
  // Among its siblings, from 1, in name order.
  position: number;
  source?: T;
}
export interface ImportPlan<T extends ImportSource> {
  // The vault's name, or '' for several things dropped together.
  name: string;
  // Whether the import gets a folder of its own (anything but loose files).
  wrap: boolean;
  // In creation order: each after the item it goes into, files early.
  items: ImportItem<T>[];
  skipped: { path: string; reason: string }[];
  bytes: number;
  // The item a link in the note at `from` points at, or null.
  resolve: (from: string, target: string, wiki: boolean) => string | null;
}

export const IMPORT_LIMIT = 2000;
const TEXT_BYTES = 1024 * 1024;
const FILE_BYTES = 50_000_000;
const KINDS: [RegExp, ImportKind][] = [
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.txt$/i, 'text'],
  [/\.pdf$/i, 'pdf'],
  [/\.(png|jpe?g|gif|webp|avif|svg)$/i, 'image'],
];
// Editor settings, version control and system files are not notes.
const IGNORED = (segment: string) =>
  segment.startsWith('.') || ['__MACOSX', 'Thumbs.db', 'desktop.ini'].includes(segment);
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });
const stem = (name: string) => name.replace(/\.[^./]*$/, '');
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
// A path inside the vault with '.' and '..' applied, or null outside it.
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

export function planImport<T extends ImportSource>(sources: T[]): ImportPlan<T> {
  const skipped: ImportPlan<T>['skipped'] = [];
  let kept: { path: string; kind: ImportKind; source: T }[] = [];
  for (const source of sources) {
    const path = normalize(source.path);
    if (!path || path.split('/').some(IGNORED)) continue;
    const kind = KINDS.find(([pattern]) => pattern.test(path))?.[1];
    if (!kind) skipped.push({ path, reason: '不支持的文件类型' });
    else if (kind === 'markdown' || kind === 'text') {
      if (source.size > TEXT_BYTES) skipped.push({ path, reason: '正文超过 1 MiB' });
      else kept.push({ path, kind, source });
    } else if (source.size > FILE_BYTES) skipped.push({ path, reason: '文件超过 50 MB' });
    else if (!source.size) skipped.push({ path, reason: '文件为空' });
    else kept.push({ path, kind, source });
  }
  // One directory: its name, and paths inside it.
  const firsts = new Set(kept.map((entry) => (entry.path.includes('/') ? entry.path.split('/')[0] : '')));
  const name = firsts.size === 1 && !firsts.has('') ? [...firsts][0] : '';
  const wrap = kept.some((entry) => entry.path.includes('/')) || (!kept.length && !!name);
  if (name) {
    kept = kept.map((entry) => ({ ...entry, path: entry.path.slice(name.length + 1) }));
    for (const item of skipped) if (item.path.startsWith(`${name}/`)) item.path = item.path.slice(name.length + 1);
  }

  const directories = new Set<string>();
  for (const entry of kept)
    for (let dir = dirname(entry.path); dir && !directories.has(dir); dir = dirname(dir)) directories.add(dir);
  const files = new Map(kept.map((entry) => [entry.path, entry]));
  // A folder note: `D.md` beside `D/`, or `D/D.md` inside it, holds D's contents.
  const holder = new Map<string, string>();
  for (const dir of directories) {
    const beside = `${dir}.md`,
      inside = `${dir}/${basename(dir)}.md`;
    const note = [beside, inside].find((path) => files.get(path)?.kind === 'markdown');
    if (note) holder.set(dir, note);
  }
  // The item that holds what is in `dir` ('' is the top).
  const container = (dir: string): string | null => (dir ? (holder.get(dir) ?? dir) : null);

  const items: ImportItem<T>[] = [];
  for (const dir of directories)
    if (!holder.has(dir))
      items.push({ path: dir, title: basename(dir), kind: 'folder', parent: container(dirname(dir)), position: 0 });
  for (const entry of kept) {
    const dir = dirname(entry.path);
    // A note inside the folder it holds goes where the folder would have been.
    const parent = holder.get(dir) === entry.path ? container(dirname(dir)) : container(dir);
    items.push({
      path: entry.path,
      title: entry.kind === 'markdown' || entry.kind === 'text' ? stem(basename(entry.path)) : basename(entry.path),
      kind: entry.kind,
      parent,
      position: 0,
      source: entry.source,
    });
  }
  const children = new Map<string | null, ImportItem<T>[]>();
  for (const item of items) children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
  const holds = (item: ImportItem<T>) => item.kind === 'folder' || children.has(item.path);
  for (const list of children.values()) {
    list.sort((a, b) => Number(holds(b)) - Number(holds(a)) || collator.compare(a.title, b.title));
    list.forEach((item, index) => (item.position = index + 1));
  }
  // Each item after its parent; folders and files before notes where that is
  // free, so a note's images are mostly entries already when it links them.
  const order: ImportItem<T>[] = [];
  const ready = [...(children.get(null) ?? [])];
  const rank = (item: ImportItem<T>) => (item.kind === 'markdown' || item.kind === 'text' ? 1 : 0);
  while (ready.length) {
    let next = 0;
    for (let i = 1; i < ready.length; i++) if (rank(ready[i]) < rank(ready[next])) next = i;
    const [item] = ready.splice(next, 1);
    order.push(item);
    ready.push(...(children.get(item.path) ?? []));
  }

  // Links: exact paths (case-insensitive), file names, and note names.
  const exact = new Map<string, string>(),
    names = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string) =>
    map.set(key, [...(map.get(key) ?? []), path]);
  for (const item of items) {
    if (item.kind === 'folder') continue;
    exact.set(item.path.toLowerCase(), item.path);
    add(names, basename(item.path).toLowerCase(), item.path);
    if (item.kind === 'markdown') add(names, stem(basename(item.path)).toLowerCase(), item.path);
  }
  for (const [dir, note] of holder) exact.set(dir.toLowerCase(), note);
  // Obsidian's rule when names repeat: the shortest path.
  const shortest = (paths: string[] | undefined) =>
    paths?.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0] ?? null;
  const lookup = (path: string | null) =>
    path === null ? null : (exact.get(path.toLowerCase()) ?? exact.get(`${path.toLowerCase()}.md`) ?? null);
  const resolve = (from: string, target: string, wiki: boolean): string | null => {
    const value = target.replace(/\\/g, '/');
    if (wiki) {
      if (!value.includes('/')) return shortest(names.get(value.toLowerCase()));
      const tail = value.toLowerCase().replace(/^\/+/, '');
      return (
        lookup(normalize(tail)) ??
        shortest(
          items
            .filter((item) => item.kind !== 'folder')
            .map((item) => item.path)
            .filter((path) => {
              const lower = path.toLowerCase();
              return lower.endsWith(`/${tail}`) || lower.endsWith(`/${tail}.md`);
            }),
        )
      );
    }
    // Relative to the note; else from the vault's top; else by name.
    const found =
      lookup(normalize(`${dirname(from)}/${value}`)) ?? lookup(normalize(value));
    if (found || value.includes('/')) return found;
    return shortest(names.get(value.toLowerCase()));
  };
  return {
    name,
    wrap,
    items: order,
    skipped,
    bytes: kept.reduce((sum, entry) => sum + entry.source.size, 0),
    resolve,
  };
}

// What one import has done so far; a retry continues from it.
export interface ImportState<T extends ImportSource & { file: File }> {
  plan: ImportPlan<T>;
  parentId: string | null;
  title: string;
  rootId: string | null;
  ids: Map<string, string>;
  blobs: Map<string, FileInfo>;
  created: Set<string>;
  failed: Map<string, string>;
  // Link targets that were not found, by note.
  missing: Map<string, string[]>;
}
// The folder an import goes into: 「库 导入 2026-10-19」.
export function importTitle(plan: ImportPlan<ImportSource>, today = new Date()) {
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `${plan.name ? `${plan.name} ` : ''}导入 ${date}`;
}
export function startImport<T extends ImportSource & { file: File }>(
  plan: ImportPlan<T>,
  parentId: string | null,
  today = new Date(),
): ImportState<T> {
  return {
    plan,
    parentId,
    title: importTitle(plan, today),
    rootId: plan.wrap ? crypto.randomUUID() : null,
    // The device names every entry, so links can be written before they exist.
    ids: new Map(plan.items.map((item) => [item.path, crypto.randomUUID()])),
    blobs: new Map(),
    created: new Set(),
    failed: new Map(),
    missing: new Map(),
  };
}
export interface ImportProgress {
  done: number;
  total: number;
  current: string;
}
// A failure that stops the whole import (a lost connection, a locked key).
const fatal = (error: unknown) =>
  error instanceof LockedError || (error instanceof ApiError && (error.status === 0 || error.status === 401));

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  let stop: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length && !stop) {
        const item = items[next++];
        try {
          await run(item);
        } catch (error) {
          stop = error;
        }
      }
    }),
  );
  if (stop) throw stop;
}

// Uploads the files, then creates every entry not created yet, each after the
// entry it goes into. Entries that fail are kept in `failed` for a retry;
// a lost connection or a locked key stops it with that error.
export async function runImport<T extends ImportSource & { file: File }>(
  state: ImportState<T>,
  onProgress: (progress: ImportProgress) => void,
  signal: AbortSignal,
) {
  const { plan } = state;
  state.failed.clear();
  const uploads = plan.items.filter((item) => (item.kind === 'pdf' || item.kind === 'image') && !state.blobs.has(item.path));
  const pending = plan.items.filter((item) => !state.created.has(item.path));
  const total = uploads.length + pending.length + (state.rootId && !state.created.has('') ? 1 : 0);
  let done = 0;
  const step = (current: string) => onProgress({ done: done++, total, current });
  const top = state.rootId ?? state.parentId;
  if (state.rootId && !state.created.has('')) {
    step(state.title);
    await api('/api/nodes', 'POST', { id: state.rootId, kind: 'folder', title: state.title, parentId: state.parentId }, state.rootId);
    state.created.add('');
  }
  const failed = (item: ImportItem<T>, error: unknown) => {
    if (fatal(error)) throw error;
    state.failed.set(item.path, (error as Error).message || '导入失败。');
  };
  // Files are sealed for the import's place, which every entry inside inherits.
  await pool(uploads, 3, async (item) => {
    signal.throwIfAborted();
    step(item.path);
    try {
      state.blobs.set(item.path, await upload(item.source!.file, top));
    } catch (error) {
      failed(item, error);
    }
  });
  const finished = new Map<string, Promise<boolean>>();
  const byPath = new Map(plan.items.map((item) => [item.path, item]));
  const create = async (item: ImportItem<T>): Promise<boolean> => {
    if (state.created.has(item.path)) return true;
    if (item.parent !== null && !(state.created.has(item.parent) || (await finished.get(item.parent)))) {
      state.failed.set(item.path, '所在文件夹未能导入。');
      return false;
    }
    signal.throwIfAborted();
    step(item.path);
    const id = state.ids.get(item.path)!;
    const body: Record<string, unknown> = {
      id,
      kind: item.kind,
      title: item.title,
      parentId: item.parent === null ? top : state.ids.get(item.parent),
      // Loose files dropped into an existing folder go after what is there.
      ...(item.parent !== null || state.rootId ? { position: item.position } : {}),
    };
    try {
      if (item.kind === 'pdf' || item.kind === 'image') {
        const blob = state.blobs.get(item.path);
        if (!blob) throw new Error(state.failed.get(item.path) ?? '文件未能上传。');
        body.fileId = blob.id;
      } else if (item.kind !== 'folder') {
        const text = await item.source!.file.text();
        if (item.kind === 'markdown') {
          const { content, missing } = rewriteLinks(text, (target, wiki) => {
            const path = plan.resolve(item.path, target, wiki);
            const to = path === null ? undefined : byPath.get(path);
            if (!to) return null;
            const link = `/n/${state.ids.get(to.path)}`;
            if (to.kind !== 'image') return { link };
            const blob = state.blobs.get(to.path);
            return blob ? { link, image: `/api/files/${blob.id}` } : null;
          });
          body.content = content;
          if (missing.length) state.missing.set(item.path, [...new Set(missing)]);
        } else body.content = text;
      }
      await api('/api/nodes', 'POST', body, id);
      state.created.add(item.path);
      return true;
    } catch (error) {
      failed(item, error);
      return false;
    }
  };
  // Entries go one after another in order, a few at a time; each waits for its parent.
  await pool(pending, 4, async (item) => {
    const result = create(item);
    finished.set(item.path, result);
    await result;
  });
  onProgress({ done, total, current: '' });
}

export type ImportFile = ImportSource & { file: File };
// Desktop browsers that can pick a directory; phones and the Android app cannot.
export const canImportFolders = () =>
  'webkitdirectory' in HTMLInputElement.prototype &&
  !window.matchMedia?.('(pointer: coarse)').matches &&
  !Capacitor.isNativePlatform();
// Files picked with <input webkitdirectory> (or several loose files).
export const pickedFiles = (files: FileList | File[]): ImportFile[] =>
  [...files].map((file) => ({ path: file.webkitRelativePath || file.name, size: file.size, file }));
// What was dropped on the window, directories walked through.
export async function droppedFiles(items: DataTransferItemList): Promise<ImportFile[]> {
  const found: ImportFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      found.push({ path: entry.fullPath.replace(/^\/+/, ''), size: file.size, file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory is read in batches until one comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return;
      for (const child of batch) await walk(child);
    }
  };
  // Entries must be taken before the first await; the list empties after the event.
  const entries = [...items].map((item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
  for (const entry of entries) await walk(entry);
  return found;
}
