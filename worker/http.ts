export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_FAILED',
  ) {
    super(message);
  }
}
export const json = (value: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new AppError(415, '请使用 JSON 请求。');
  // JSON escaping can expand one byte of plain text into six bytes (e.g. \u0000).
  // The decoded text still has the independent 1 MiB UTF-8 bound in storage.ts.
  const limit = 6 * 1_048_576 + 65_536;
  if (Number(request.headers.get('content-length')) > limit)
    throw new AppError(413, '请求内容过大。');
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError(413, '请求内容过大。');
      }
      chunks.push(item.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new AppError(400, '请求格式不正确。');
  }
}
export function textValue(value: unknown, label: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max)
    throw new AppError(400, `${label}不能为空，且最多 ${max} 个字符。`);
  return value;
}
export function integer(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError(400, `${label}不正确。`);
  return value;
}
export function idValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new AppError(400, '标识不正确。');
  return value;
}
export function enforceOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let same = origin === url.origin;
  if (origin && local) {
    try {
      same ||= ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    } catch {
      /* invalid origin */
    }
  }
  if (!same || request.headers.get('sec-fetch-site') === 'cross-site')
    throw new AppError(403, '请从本站页面执行此操作。', 'INVALID_ORIGIN');
}
export function asError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = String(error instanceof Error ? `${error.message} ${error.cause ?? ''}` : error);
  const known: [string, number, string][] = [
    ['QUOTA_EXCEEDED', 413, '空间不足，请清理回收站或调整容量上限。'],
    ['VERSION_CONFLICT', 409, '这篇笔记已在其他页面更新，当前编辑内容已保留。'],
    ['INVALID_PARENT', 409, '目标位置不存在、已删除或不能包含子节点。'],
    ['TREE_CYCLE', 400, '不能把节点移动到自己的子节点中。'],
    ['FILE_UNAVAILABLE', 409, '文件尚未上传完成或已被清理，请重新上传。'],
    ['NODE_UNAVAILABLE', 404, '节点不存在或已进入回收站。'],
    ['TREE_CHANGED', 409, '目录内容发生了变化，请重新确认删除范围。'],
    ['UNIQUE constraint failed: idempotency', 409, '相同操作正在处理中，请稍后刷新。'],
  ];
  for (const [code, status, label] of known)
    if (message.includes(code)) return new AppError(status, label, code);
  return new AppError(500, '操作未完成，已保存的数据仍然保留。请稍后重试。', 'INTERNAL_ERROR');
}
