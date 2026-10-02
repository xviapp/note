import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    apk: { type: 'string' },
    notes: { type: 'string' },
    remote: { type: 'boolean' },
  },
});
if (!values.apk || !values.notes)
  throw new Error('需要 --apk <安装包> 和 --notes <更新说明文件>；加 --remote 发布到已配置的 R2。');
const sdk = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(homedir(), 'Android/Sdk'),
].find((p) => p && existsSync(path.join(p, 'build-tools')));
if (!sdk) throw new Error('未找到 Android SDK。');
const versions = (await readdir(path.join(sdk, 'build-tools'))).sort((a, b) =>
  b.localeCompare(a, undefined, { numeric: true }),
);
const bin = path.join(sdk, 'build-tools', versions[0]);
const apk = path.resolve(values.apk);
const badging = execFileSync(path.join(bin, 'aapt'), ['dump', 'badging', apk], {
  encoding: 'utf8',
});
const pkg = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
if (pkg?.[1] !== 'app.xvi.note') throw new Error('安装包不是页间。');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg[3] !== version) throw new Error('安装包版本与当前源码不同，请重新构建。');
const signatures = execFileSync(path.join(bin, 'apksigner'), ['verify', '--print-certs', apk], {
  encoding: 'utf8',
});
// Build Tools 37 labels this "V2 Signer:"; earlier tools use "Signer #1".
const certificates = [
  ...new Set(
    Array.from(
      signatures.matchAll(
        /^(?:Signer #\d+|V\d+ Signer):? certificate SHA-256 digest: ([a-f0-9]{64})$/gm,
      ),
      (match) => match[1],
    ),
  ),
];
if (certificates.length !== 1) throw new Error('安装包签名验证失败或包含不支持的多个签名。');
const certificate = certificates[0];
const sha = createHash('sha256');
for await (const chunk of createReadStream(apk)) sha.update(chunk);
const notes = (await readFile(values.notes, 'utf8')).trim();
const size = (await stat(apk)).size;
if (!notes || notes.length > 8000 || size > 200 * 1024 * 1024)
  throw new Error('更新说明或安装包大小不符合要求。');
const release = {
  version,
  build: Number(pkg[2]),
  size,
  sha256: sha.digest('hex'),
  certificate,
  publishedAt: new Date().toISOString(),
  notes,
};
const manifest = `${apk}.json`;
await writeFile(manifest, JSON.stringify(release, null, 2) + '\n');
if (values.remote) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const put = (key, file, type) =>
    execFileSync(
      command,
      [
        'wrangler',
        'r2',
        'object',
        'put',
        `xvi-note-files/${key}`,
        '--file',
        file,
        '--content-type',
        type,
        '--remote',
        '--env',
        'production',
      ],
      { stdio: 'inherit' },
    );
  // Publish immutable bytes first. Readers only see the version after all data is available.
  put(
    `releases/android/${release.build}/${release.sha256}.apk`,
    apk,
    'application/vnd.android.package-archive',
  );
  put('releases/android/latest.json', manifest, 'application/json');
  console.log(`已发布页间 ${version}，构建 ${release.build}`);
} else console.log(`校验通过，更新清单：${manifest}\n加 --remote 后发布。`);
