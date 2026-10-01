import type { FileInfo } from '../shared/types';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
let libraryToken = '';
const noteTokens = new Map<string, string>();
export function lockEdits() {
  libraryToken = '';
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
  const headers: Record<string, string> = {};
  if (data !== undefined) headers['content-type'] = 'application/json';
  if (libraryToken) headers['x-library-edit'] = libraryToken;
  const node = path.match(/^\/api\/nodes\/([^/]+)/)?.[1];
  if (node && noteTokens.has(node)) headers['x-note-edit'] = noteTokens.get(node)!;
  if (method !== 'GET') headers['x-idempotency-key'] = key ?? crypto.randomUUID();
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return parse<T>(response);
}
async function parse<T>(response: Response): Promise<T> {
  const value = (await response
    .json()
    .catch(() => ({ error: '服务器暂时无法响应，请稍后重试。' }))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    if (response.status === 401 && value.code === 'UNAUTHENTICATED') {
      lockEdits();
      window.dispatchEvent(new Event('note:unauthenticated'));
    }
    if (response.status === 403 && value.code === 'EDIT_LOCKED') {
      lockEdits();
      window.dispatchEvent(new Event('note:edit-expired'));
    }
    throw new ApiError(value.error || '操作未完成。', response.status, value.code);
  }
  return value as T;
}
export async function unlockLibrary() {
  const result = await api<{ token: string }>('/api/edit/unlock', 'POST', {});
  libraryToken = result.token;
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
      headers: { 'x-library-edit': libraryToken },
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
