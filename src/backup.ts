import { Capacitor, registerPlugin } from '@capacitor/core';
import { api, fileUrl, parse } from './api';
import { BACKUP_METADATA_LIMIT, validateBackup, type LibraryBackup } from '../shared/backup';
import type { FileEntry, ZipReader } from '@zip.js/zip.js';

const archiveDevice = registerPlugin<{
  begin(options: { name: string }): Promise<{ cancelled: boolean; id: string }>;
  write(options: { id: string; data: string }): Promise<void>;
  finish(options: { id: string }): Promise<void>;
  abort(options: { id: string }): Promise<void>;
}>('NoteArchive');
interface Destination {
  stream: WritableStream<Uint8Array>;
  finish(): Promise<void>;
  abort(): Promise<void>;
  limit?: number;
}
async function destination(name: string): Promise<Destination | null> {
  if (Capacitor.isNativePlatform()) {
    const choice = await archiveDevice.begin({ name });
    if (choice.cancelled) return null;
    return {
      stream: new WritableStream({
        async write(chunk: Uint8Array) {
          for (let offset = 0; offset < chunk.length; offset += 192 * 1024) {
            const part = chunk.subarray(offset, offset + 192 * 1024);
            let text = '';
            for (let i = 0; i < part.length; i += 8192)
              text += String.fromCharCode(...part.subarray(i, i + 8192));
            await archiveDevice.write({ id: choice.id, data: btoa(text) });
          }
        },
      }),
      finish: () => archiveDevice.finish({ id: choice.id }),
      abort: () => archiveDevice.abort({ id: choice.id }),
    };
  }
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (
        options: unknown,
      ) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
    }
  ).showSaveFilePicker;
  if (picker) {
    const file = await picker({
      suggestedName: name,
      types: [{ description: '页间备份', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await file.createWritable();
    const writer = writable.getWriter();
    return {
      stream: new WritableStream({ write: (chunk) => writer.write(chunk) }),
      finish: () => writer.close(),
      abort: () => writer.abort(),
    };
  }
  const chunks: BlobPart[] = [];
  let size = 0;
  const limit = 256 * 1024 * 1024;
  return {
    limit,
    stream: new WritableStream({
      write(chunk: Uint8Array<ArrayBuffer>) {
        size += chunk.length;
        if (size > limit)
          throw new Error('请使用 Android 客户端或桌面 Chrome 保存超过 256 MiB 的备份。');
        chunks.push(chunk);
      },
    }),
    async finish() {
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    async abort() {
      chunks.length = 0;
    },
  };
}
export async function exportLibrary(progress: (message: string) => void, signal: AbortSignal) {
  const sink = await destination(`页间备份-${new Date().toISOString().slice(0, 10)}.zip`);
  if (!sink) return false;
  let jobId = '';
  try {
    progress('正在建立备份快照…');
    signal.throwIfAborted();
    const { id, archive } = await api<{ id: string; archive: LibraryBackup }>(
      '/api/backups',
      'POST',
      {},
    );
    jobId = id;
    validateBackup(archive);
    if (
      sink.limit &&
      archive.files.reduce((sum, file) => sum + file.size, 0) + BACKUP_METADATA_LIMIT > sink.limit
    )
      throw new Error('此备份较大，请使用 Android 客户端或桌面 Chrome 保存。');
    const { ZipWriter } = await import('@zip.js/zip.js');
    const zip = new ZipWriter(sink.stream, {
      level: 0,
      zip64: true,
      useWebWorkers: false,
      bufferedWrite: false,
    });
    await zip.add('yejian.json', new Blob([JSON.stringify(archive)]).stream(), { signal });
    for (const [index, file] of archive.files.entries()) {
      signal.throwIfAborted();
      progress(`正在备份 ${index + 1}/${archive.files.length}：${file.name}`);
      const response = await fetch(fileUrl(file.id), { credentials: 'same-origin', signal });
      if (!response.ok || !response.body) throw new Error(`无法读取「${file.name}」，备份未完成。`);
      let bytes = 0;
      const content = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            bytes += chunk.length;
            if (bytes > file.size) throw new Error('文件大小发生变化，请重新备份。');
            controller.enqueue(chunk);
          },
          flush() {
            if (bytes !== file.size) throw new Error('文件下载不完整，备份未完成。');
          },
        }),
      );
      await zip.add(`files/${file.id}`, content, { signal });
    }
    await zip.close();
    signal.throwIfAborted();
    await sink.finish();
    return true;
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  } finally {
    if (jobId) await api(`/api/backups/${jobId}`, 'DELETE').catch(() => {});
  }
}
export interface OpenBackup {
  archive: LibraryBackup;
  entries: Map<string, FileEntry>;
  reader: ZipReader<Blob>;
  key: string;
}
async function readEntry(entry: FileEntry, limit: number, signal?: AbortSignal) {
  const chunks: BlobPart[] = [];
  let size = 0;
  await entry.getData(
    new WritableStream({
      write(chunk: Uint8Array<ArrayBuffer>) {
        size += chunk.length;
        if (size > limit) throw new Error('备份文件超过清单中的大小。');
        chunks.push(chunk);
      },
    }),
    { checkCrc32: true, signal },
  );
  if (size !== entry.uncompressedSize) throw new Error('备份文件内容不完整。');
  return new Blob(chunks);
}
export async function openBackup(file: File): Promise<OpenBackup> {
  const { ZipReader, BlobReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(file), {
    useWebWorkers: false,
    checkCrc32: true,
    strictness: 'strict',
    checkOverlappingEntry: true,
  });
  try {
    const entries = new Map<string, FileEntry>();
    for await (const entry of reader.getEntriesGenerator()) {
      if (
        entry.directory ||
        entry.encrypted ||
        entries.has(entry.filename) ||
        !(entry.filename === 'yejian.json' || /^files\/[a-zA-Z0-9_-]{1,80}$/.test(entry.filename))
      )
        throw new Error('备份包含不支持的文件或重复路径。');
      entries.set(entry.filename, entry);
      if (entries.size > 100000) throw new Error('备份目录过大。');
    }
    const manifest = entries.get('yejian.json');
    if (!manifest || manifest.uncompressedSize > BACKUP_METADATA_LIMIT)
      throw new Error('未找到有效的页间备份清单。');
    const archive = validateBackup(
      JSON.parse(await (await readEntry(manifest, BACKUP_METADATA_LIMIT)).text()),
    );
    if (entries.size !== archive.files.length + 1) throw new Error('备份文件数量与清单不符。');
    for (const file of archive.files)
      if (entries.get(`files/${file.id}`)?.uncompressedSize !== file.size)
        throw new Error(`备份缺少或损坏：${file.name}`);
    return { archive, entries, reader, key: crypto.randomUUID() };
  } catch (error) {
    await reader.close();
    throw error;
  }
}
export async function restoreLibrary(
  backup: OpenBackup,
  progress: (message: string) => void,
  signal: AbortSignal,
) {
  const state = await api<{ id: string; rootId: string | null }>(
    '/api/backups/restore',
    'POST',
    backup.archive,
    backup.key,
  );
  if (state.rootId) return state.rootId;
  for (const [index, file] of backup.archive.files.entries()) {
    signal.throwIfAborted();
    progress(`正在恢复 ${index + 1}/${backup.archive.files.length}：${file.name}`);
    const blob = await readEntry(backup.entries.get(`files/${file.id}`)!, file.size, signal);
    await parse(
      await fetch(`/api/backups/${state.id}/files/${file.id}`, {
        method: 'POST',
        body: blob,
        signal,
        credentials: 'same-origin',
      }),
    );
  }
  signal.throwIfAborted();
  progress('正在恢复目录和记录…');
  return (await api<{ rootId: string }>(`/api/backups/${state.id}/commit`, 'POST', {})).rootId;
}
