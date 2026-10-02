import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const sdk = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(homedir(), 'Android/Sdk'),
  path.join(homedir(), 'Library/Android/sdk'),
].find((value) => value && existsSync(path.join(value, 'platform-tools')));
if (!sdk) throw new Error('请先安装 Android SDK，并设置 ANDROID_SDK_ROOT。');
await writeFile(
  'android/local.properties',
  `sdk.dir=${sdk.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`,
);
const task = process.argv[2] || 'assembleDebug';
if (!['assembleDebug', 'testDebugUnitTest', 'lintDebug'].includes(task))
  throw new Error('Unsupported Android task');
const child = spawn(
  process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  [...(process.platform === 'win32' ? ['/d', '/c', 'gradlew.bat'] : []), task, '--console=plain'],
  {
    cwd: 'android',
    stdio: 'inherit',
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  },
);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
if (code !== 0) process.exit(code || 1);
if (task === 'assembleDebug') {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const output = `artifacts/yejian-${version}-android-debug.apk`;
  await mkdir('artifacts', { recursive: true });
  await copyFile('android/app/build/outputs/apk/debug/app-debug.apk', output);
  console.log(`APK: ${path.resolve(output)}`);
}
