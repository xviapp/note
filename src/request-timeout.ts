// AbortSignal.timeout/any are unavailable in some browsers and WebViews.
// Keep the deadline active through body reads and release it on completion.
export async function withRequestTimeout<T>(
  milliseconds: number,
  request: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('请求超时。', 'TimeoutError')),
    milliseconds,
  );
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  }
}
