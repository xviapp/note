let ready: Promise<void> | undefined;
export function prepareOfflineShell(): Promise<void> {
  if (!import.meta.env.PROD || import.meta.env.MODE === 'android') return Promise.resolve();
  if (!('serviceWorker' in navigator))
    return Promise.reject(new Error('此浏览器暂不支持离线打开页面。'));
  return (ready ??= (async () => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    if (registration.active) return;
    await new Promise<void>((resolve, reject) => {
      const worker = registration.installing || registration.waiting;
      const timer = window.setTimeout(
        () => finish(new Error('离线页面资源尚未准备完成，请稍后重试。')),
        60_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        worker?.removeEventListener('statechange', changed);
        error ? reject(error) : resolve();
      };
      const changed = () => {
        if (worker?.state === 'activated' || registration.active) finish();
        else if (!worker || worker.state === 'redundant')
          finish(new Error('离线页面资源下载未完成，请联网后重试。'));
      };
      worker?.addEventListener('statechange', changed);
      changed();
    });
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
