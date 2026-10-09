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

// Read a request or response stream while enforcing its byte limit. Keeping
// the reader lifecycle here makes all streaming endpoints cancel and release
// their readers the same way when a limit is exceeded or the stream ends.
export async function readLimited(
  stream: ReadableStream<Uint8Array> | null | undefined,
  limit: number,
  tooLarge = '请求内容过大。',
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new AppError(413, tooLarge);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function sseResponse<TEvent>(
  request: Request,
  execution: ExecutionContext,
  run: (signal: AbortSignal, emit: (event: TEvent) => void) => Promise<void>,
  timeout?: number,
): Response {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  const timer = timeout === undefined ? undefined : setTimeout(() => abort.abort('timeout'), timeout);
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: TEvent) => {
        if (disconnected) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          disconnected = true;
          abort.abort();
        }
      };
      execution.waitUntil(
        Promise.resolve()
          .then(() => run(abort.signal, emit))
          .catch(() => {})
          .finally(() => {
            if (timer !== undefined) clearTimeout(timer);
            request.signal.removeEventListener('abort', onAbort);
            if (!disconnected) controller.close();
          }),
      );
    },
    cancel() {
      disconnected = true;
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function body<T = Record<string, unknown>>(
  request: Request,
  limit = 6 * 1_048_576 + 65_536,
  tooLarge = '请求内容过大。',
): Promise<T> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new AppError(415, '请使用 JSON 请求。');
  // JSON escaping can expand one byte of plain text into six bytes (e.g. \u0000).
  // Notes retain their independent 1 MiB UTF-8 bound in storage.ts.
  if (Number(request.headers.get('content-length')) > limit) throw new AppError(413, tooLarge);
  const bytes = await readLimited(request.body, limit, tooLarge);
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
    ['INVALID_FOLDER_ICON', 400, '文件夹图标需要使用不超过 128 KiB 的图片。'],
    ['NODE_UNAVAILABLE', 404, '节点不存在或已进入回收站。'],
    ['TREE_CHANGED', 409, '目录内容发生了变化，请重新确认删除范围。'],
    ['UNIQUE constraint failed: idempotency', 409, '相同操作正在处理中，请稍后刷新。'],
  ];
  for (const [code, status, label] of known)
    if (message.includes(code)) return new AppError(status, label, code);
  return new AppError(500, '操作未完成，已保存的数据仍然保留。请稍后重试。', 'INTERNAL_ERROR');
}
