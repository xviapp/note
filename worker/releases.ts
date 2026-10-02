import { validRelease } from '../shared/release';
import { AppError, json } from './http';
import type { Env } from './types';

// Releases are deployment-owned objects, separate from the private library.
// The caller must have authenticated before entering this module.
export async function androidRelease(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/app/android-release') {
    const object = await env.FILES.get('releases/android/latest.json');
    if (!object) return json({ release: null });
    if (object.size > 65536) throw new AppError(502, '更新信息暂时无法读取。');
    const release: unknown = await object.json();
    if (!validRelease(release)) throw new AppError(502, '更新信息不完整，请稍后重试。');
    return json({ release });
  }
  const match = path.match(/^\/api\/app\/android-release\/([1-9]\d{0,8})\/([a-f0-9]{64})\.apk$/);
  if (!match) throw new AppError(404, '安装包不存在。');
  const key = `releases/android/${match[1]}/${match[2]}.apk`;
  const object = request.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!object) throw new AppError(404, '安装包已移除，请重新检查更新。');
  return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="yejian-${match[1]}.apk"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
