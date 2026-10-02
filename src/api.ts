import type { AuthStatus, FileInfo, NoteDetail } from '../shared/types';
import {
  cacheEpoch,
  cachedResponse,
  clearPrivateCache,
  rememberNote,
  rememberResponse,
  removeCachedNote,
} from './offline-cache';
import { isOffline, setOffline } from './connectivity';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
const noteTokens = new Map<string, string>();
export function lockEdits() {
  noteTokens.clear();
}
export function lockNote(id: string) {
  noteTokens.delete(id);
}
export async function api<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  key?: string,
): Promise<T> {
  const epoch = cacheEpoch();
  const authProbe = path === '/api/auth/status';
  if (isOffline() && !authProbe) {
    const cached = method === 'GET' ? await cachedResponse<T>(path) : undefined;
    if (cached !== undefined) return cached;
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
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(method === 'GET' ? { signal: AbortSignal.timeout(authProbe ? 5000 : 10_000) } : {}),
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    setOffline(true);
    const cached = method === 'GET' ? await cachedResponse<T>(path) : undefined;
    if (cached !== undefined) return cached;
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
  if (authProbe && !(value as AuthStatus).authenticated) await clearPrivateCache();
  else {
    if (method === 'GET') {
      await rememberResponse(path, value, epoch).catch(() => {});
      if (/^\/api\/nodes\/[\w-]+$/.test(path))
        void rememberNote(value as NoteDetail, false, epoch).catch(() => {});
    }
    if (/^\/api\/auth\/(logout|logout-all|password)$/.test(path) && method === 'POST')
      await clearPrivateCache();
    if (node && method === 'DELETE' && path === `/api/nodes/${node}`)
      await removeCachedNote(node).catch(() => {});
  }
  if (authProbe) setOffline(false);
  return value;
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
      await clearPrivateCache();
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
export async function upload(file: File): Promise<FileInfo> {
  const response = await fetch(
    `/api/files?name=${encodeURIComponent(file.name)}&size=${file.size}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    },
  );
  return parse<FileInfo>(response);
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
