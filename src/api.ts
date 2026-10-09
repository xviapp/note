import { TEXT_KINDS, type AuthStatus, type FileInfo, type NoteDetail } from '../shared/types';
import type { Annotation, AnnotationList } from '../shared/annotations';
import { KEY_HEADER } from '../shared/encryption';
import { markdownMetadata } from '../shared/projects';
import {
  forgetScope,
  keyOrThrow,
  knownChain,
  knownScope,
  LockedError,
  plainUpload,
  rememberScope,
  reveal,
  sealData,
  sealString,
} from './encryption';
import { keyHeader, lockAll } from './keyring';
import {
  cacheEpoch,
  cachedResponse,
  clearPrivateCache,
  rememberNote,
  rememberResponse,
  removeCachedNote,
} from './offline-cache';
import { isOffline, setOffline } from './connectivity';
import { proxyReady } from './proxy';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
// The request may have reached the server: a retry must reuse its idempotency key.
export function uncertainFailure(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}
const noteTokens = new Map<string, string>();
export function lockEdits() {
  noteTokens.clear();
}
export function lockNote(id: string) {
  noteTokens.delete(id);
}
// AI work has its own provider budget (up to twenty minutes). Ordinary
// writes should release the editor promptly when a connection stalls.
function requestTimeout(path: string, method: string) {
  if (method === 'GET') return path === '/api/auth/status' ? 5000 : 10_000;
  if (path === '/api/books/role-prompt' ||
      /^\/api\/nodes\/[^/]+\/(pages|insights|organize|book-note|paper-translation)(\/|$)/.test(path))
    return 25 * 60_000;
  if (/^\/api\/(backups|import\/arxiv|cleanup|clips\/encryption)(\/|$)/.test(path)) return 5 * 60_000;
  return 30_000;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  key?: string,
): Promise<T> {
  if (method === 'GET') return request<T>(path, method, data, key);
  // Writes into an encrypted place are sealed here first. A device that had
  // an old idea of the place's key learns the new one and seals again.
  for (let attempt = 0; ; attempt++) {
    const sealed = await sealWrite<T>(path, method, data);
    if (sealed.done) return sealed.value;
    try {
      const value = await request<T>(path, method, sealed.data, key);
      moved(path, method, data);
      return value;
    } catch (error) {
      if (attempt || !(error instanceof ApiError) || error.code !== 'ENCRYPTION_CHANGED')
        throw error;
      forgetScope(sealed.scope ?? undefined);
    }
  }
}
async function request<T>(path: string, method: string, data: unknown, key?: string): Promise<T> {
  await proxyReady();
  const epoch = cacheEpoch();
  const authProbe = path === '/api/auth/status';
  if (isOffline() && !authProbe) {
    const cached = method === 'GET' ? await cachedResponse<T>(path) : undefined;
    if (cached !== undefined) return reveal(cached);
    throw new ApiError(
      method === 'GET' ? '此内容尚未缓存，请联网后打开。' : '当前离线，联网后即可继续此操作。',
      0,
      'OFFLINE',
    );
  }
  const headers: Record<string, string> = {};
  if (data !== undefined) headers['content-type'] = 'application/json';
  const node = path.match(/^\/api\/nodes\/([^/]+)/)?.[1];
  if (node && noteTokens.has(node)) headers['x-note-edit'] = noteTokens.get(node)!;
  if (method !== 'GET') headers['x-idempotency-key'] = key ?? crypto.randomUUID();
  Object.assign(headers, await keyHeaders(path));
  let response: Response;
  const signal = AbortSignal.timeout(requestTimeout(path, method));
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      signal,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    if (signal.aborted && method !== 'GET')
      throw new ApiError('请求超时，尚无法确认是否保存成功。请保留当前内容并重试。', 0, 'REQUEST_TIMEOUT');
    setOffline(true);
    const cached = method === 'GET' ? await cachedResponse<T>(path) : undefined;
    if (cached !== undefined) return reveal(cached);
    throw new ApiError(
      method === 'GET'
        ? '无法连接，且此内容尚未缓存。请联网后重试。'
        : '连接已中断，请联网后重试。',
      0,
      'OFFLINE',
    );
  }
  // An HTTP denial/deletion must never fall back to a stale private snapshot.
  if (
    method === 'GET' &&
    /^\/api\/nodes\/[\w-]+$/.test(path) &&
    [404, 410].includes(response.status)
  )
    await removeCachedNote(node!).catch(() => {});
  const value = await parse<T>(response);
  if (
    authProbe &&
    (typeof (value as AuthStatus).authenticated !== 'boolean' ||
      typeof (value as AuthStatus).initialized !== 'boolean')
  )
    throw new ApiError('登录状态暂时无法读取，请稍后重试。', 502, 'INVALID_RESPONSE');
  if (authProbe && epoch !== cacheEpoch())
    throw new ApiError('会话已更新，请重新连接。', 409, 'SESSION_CHANGED');
  if (authProbe && !(value as AuthStatus).authenticated) await signedOut();
  else {
    if (method === 'GET') {
      await rememberResponse(path, value, epoch).catch(() => {});
      if (/^\/api\/nodes\/[\w-]+$/.test(path))
        void rememberNote(value as NoteDetail, false, epoch).catch(() => {});
    }
    if (/^\/api\/auth\/(logout|logout-all|password)$/.test(path) && method === 'POST')
      await signedOut();
    if (node && method === 'DELETE' && path === `/api/nodes/${node}`)
      await removeCachedNote(node).catch(() => {});
  }
  if (authProbe) setOffline(false);
  return reveal(value);
}
// This device's last copy of a whitelisted GET, shown while the server answers.
export async function cachedApi<T>(path: string): Promise<T | undefined> {
  const cached = await cachedResponse<T>(path);
  return cached === undefined ? undefined : reveal(cached);
}
// A moved note takes the encryption of its new place: what is unlocked is
// re-sealed in the background (the note's menu can finish the rest).
function moved(path: string, method: string, data: unknown) {
  const node = path.match(/^\/api\/nodes\/([\w-]+)$/)?.[1];
  if (!node || method !== 'PATCH' || (data as { parentId?: unknown })?.parentId === undefined)
    return;
  forgetScope();
  void import('./encryption-sync')
    .then(({ syncEncryption }) => syncEncryption(node))
    .catch(() => {});
}
// Signing out drops cached notes and locks every key on this device.
async function signedOut() {
  lockAll();
  forgetScope();
  await clearPrivateCache();
}

// The key a node's content is (or new content below it would be) sealed with.
export async function scopeOf(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const known = knownScope(id);
  if (known !== undefined) return known;
  return (await nodeKeys(id)).key_id;
}
async function nodeKeys(id: string) {
  const result = await request<{ key_id: string | null; chain: string[] }>(
    `/api/nodes/${id}/keys`,
    'GET',
    undefined,
  );
  rememberScope(id, result.key_id, result.chain);
  return result;
}
// Features the Worker runs on a note's text (青藜, translation, books,
// projects) receive the unlocked keys on the note's path for that request.
const PROCESSING =
  /^\/api\/nodes\/([\w-]+)\/(assistant|translations|paper-translation|project|pages$|insights$|discussions$|organize$|book-note$)/;
export async function keyHeaders(path: string): Promise<Record<string, string>> {
  const node = path.match(PROCESSING)?.[1];
  if (!node || node === 'qingli-global') return {};
  let chain = knownChain(node);
  if (!chain)
    chain = await nodeKeys(node)
      .then((result) => result.chain)
      .catch(() => []);
  const value = chain.length ? await keyHeader(chain) : '';
  return value ? { [KEY_HEADER]: value } : {};
}

type Sealed<T> = { done: true; value: T } | { done: false; data: unknown; scope?: string | null };
const ids = (content: string) =>
  [...content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g)].map((match) => match[1]);
// A text body sealed and uploaded on its own; the request then names it.
async function sealBody(keyId: string, kind: string, data: Record<string, unknown>) {
  const content = typeof data.content === 'string' ? data.content : '';
  const { content: _content, ...rest } = data;
  const body = await uploadSealed(
    new TextEncoder().encode(content),
    'content.txt',
    'text/plain; charset=utf-8',
    keyId,
  );
  const metadata = kind === 'markdown' ? markdownMetadata(content) : null;
  return {
    ...rest,
    bodyBlobId: body.id,
    attachments: [
      ...new Set([...(Array.isArray(data.attachments) ? data.attachments : []), ...ids(content)]),
    ],
    ...(metadata
      ? {
          metadata: {
            title: await sealString(keyId, metadata.title),
            status: await sealString(keyId, metadata.status),
            excerpt: await sealString(keyId, metadata.summary),
          },
        }
      : {}),
  };
}
async function sealWrite<T>(path: string, method: string, data: unknown): Promise<Sealed<T>> {
  const fields = (data ?? {}) as Record<string, unknown>;
  if (path === '/api/nodes' && method === 'POST' && TEXT_KINDS.includes(fields.kind as never)) {
    const parent = (fields.parentId as string | null | undefined) ?? null;
    const keyId = await scopeOf(parent);
    if (!keyId) return { done: false, data, scope: parent };
    return { done: false, data: await sealBody(keyId, String(fields.kind), fields), scope: parent };
  }
  // A journal entry is created below the journal, with its key.
  const entry = path.match(/^\/api\/nodes\/([\w-]+)\/journal\/entries$/);
  if (entry && method === 'POST') {
    const keyId = await scopeOf(entry[1]);
    if (!keyId) return { done: false, data, scope: entry[1] };
    return { done: false, data: await sealBody(keyId, 'markdown', fields), scope: entry[1] };
  }
  const save = path.match(/^\/api\/nodes\/([\w-]+)\/content$/);
  if (save && method === 'PUT') {
    const keyId = await scopeOf(save[1]);
    if (!keyId) return { done: false, data, scope: save[1] };
    // Only Markdown has summary fields; text notes ignore them.
    return { done: false, data: await sealBody(keyId, 'markdown', fields), scope: save[1] };
  }
  const annotation = path.match(/^\/api\/nodes\/([\w-]+)\/annotations\/([\w-]+)$/);
  if (annotation && (method === 'PUT' || method === 'DELETE')) {
    const keyId = await scopeOf(annotation[1]);
    if (keyId)
      return {
        done: true,
        value: (await sealedAnnotation(annotation[1], annotation[2], keyId, method, fields)) as T,
      };
  }
  return { done: false, data };
}
// An encrypted note's highlights: read, changed and sealed here, then saved
// in place of the list it was read from.
async function sealedAnnotation(
  nodeId: string,
  id: string,
  keyId: string,
  method: string,
  data: Record<string, unknown>,
): Promise<AnnotationList> {
  await keyOrThrow(keyId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const list = await request<AnnotationList>(
      `/api/nodes/${nodeId}/annotations`,
      'GET',
      undefined,
    );
    if (list.locked) throw new LockedError(list.locked);
    const now = Date.now();
    const previous = list.annotations.find((item) => item.id === id);
    let annotations: Annotation[];
    if (method === 'DELETE') {
      if (!previous) return list;
      annotations = list.annotations.filter((item) => item.id !== id);
    } else {
      const next = {
        id,
        quote: String(data.quote ?? '').trim(),
        note: String(data.note ?? '')
          .replace(/\r\n?/g, '\n')
          .trim(),
        color: (data.color ?? 'yellow') as Annotation['color'],
        location: data.location as Annotation['location'],
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      annotations = previous
        ? list.annotations.map((item) => (item.id === id ? next : item))
        : [...list.annotations, next];
    }
    const body = await uploadSealed(
      new TextEncoder().encode(JSON.stringify({ annotations })),
      'content.txt',
      'text/plain; charset=utf-8',
      keyId,
    );
    try {
      const saved = await request<AnnotationList>(`/api/nodes/${nodeId}/annotations`, 'PUT', {
        bodyBlobId: body.id,
        previous: list.body ?? null,
      });
      return { annotations, updatedAt: saved.updatedAt, body: saved.body };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'ANNOTATIONS_CHANGED') throw error;
    }
  }
  throw new ApiError('批注正在别处保存，请稍后重试。', 409);
}
export async function parse<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => {
    // A truncated successful response is not data. In particular, it must not
    // be mistaken for an unauthenticated status and erase offline snapshots.
    if (response.ok) throw new ApiError('服务器响应不完整，请稍后重试。', 502, 'INVALID_RESPONSE');
    return { error: '服务器暂时无法响应，请稍后重试。' };
  })) as {
    error?: string;
    code?: string;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('服务器响应不完整，请稍后重试。', 502, 'INVALID_RESPONSE');
  if (!response.ok) {
    if (response.status === 401 && value.code === 'UNAUTHENTICATED') {
      lockEdits();
      await signedOut();
      window.dispatchEvent(new Event('note:unauthenticated'));
    }
    if (response.status === 403 && value.code === 'EDIT_LOCKED') {
      lockEdits();
    }
    throw new ApiError(value.error || '操作未完成。', response.status, value.code);
  }
  return value as T;
}
export async function unlockNote(id: string) {
  const result = await api<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: id });
  noteTokens.set(id, result.token);
}
// Bytes sealed with a key, uploaded as one object.
export async function uploadSealed(
  bytes: Uint8Array,
  name: string,
  mime: string,
  keyId: string,
): Promise<FileInfo> {
  await proxyReady();
  const sealed = await sealData(keyId, bytes);
  const response = await uploadRequest(
    `/api/files?name=${encodeURIComponent(name)}&size=${sealed.length}&key=${keyId}&mime=${encodeURIComponent(mime)}`,
    sealed,
  );
  return parse<FileInfo>(response);
}
// `scope` is the node the file will belong to: in an encrypted place the file
// is sealed with its key before it leaves the device.
export async function upload(file: File, scope?: string | null): Promise<FileInfo> {
  await proxyReady();
  const keyId = await scopeOf(scope);
  if (keyId) {
    await keyOrThrow(keyId);
    const { bytes, mime } = await plainUpload(file);
    return uploadSealed(bytes, file.name, mime, keyId);
  }
  const response = await uploadRequest(
    `/api/files?name=${encodeURIComponent(file.name)}&size=${file.size}`,
    file,
  );
  return parse<FileInfo>(response);
}
async function uploadRequest(path: string, body: BodyInit) {
  try {
    return await fetch(path, {
      method: 'POST', credentials: 'same-origin', body,
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch {
    throw new ApiError('文件上传超时或连接中断，请保留原文件并重试。', 0, 'UPLOAD_INTERRUPTED');
  }
}
export const fileUrl = (id: string, download = false) =>
  `/api/files/${encodeURIComponent(id)}${download ? '?download=1' : ''}`;
export const formatBytes = (bytes: number) =>
  bytes < 1000
    ? `${bytes} B`
    : bytes < 1e6
      ? `${(bytes / 1000).toFixed(1)} KB`
      : bytes < 1e9
        ? `${(bytes / 1e6).toFixed(1)} MB`
        : `${(bytes / 1e9).toFixed(2)} GB`;
export const formatDate = (value: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
