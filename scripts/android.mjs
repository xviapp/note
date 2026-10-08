import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const task = process.argv[2] || 'assembleDebug';
if (
  !['assembleDebug', 'assembleRelease', 'testDebugUnitTest', 'lintDebug', 'install', 'installRelease'].includes(task)
)
  throw new Error('Unsupported Android task');
const installing = task === 'install' || task === 'installRelease';
const release = task === 'assembleRelease' || task === 'installRelease';
const installCommand = release ? 'install:android:release' : 'install:android';
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    device: { type: 'string', short: 's' },
    abi: { type: 'string', default: 'arm64-v8a' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(`pnpm ${installCommand} [--device <serial>]

构建最新版 APK，并通过 adb 覆盖安装，保留应用数据。
只有一个可用设备时自动选择；多个设备时使用 --device 或 ANDROID_SERIAL 指定。
需要 JDK 21、Android SDK，以及已开启 USB 调试并授权的手机或模拟器。
仅构建 APK：pnpm android:apk
正式构建 APK：pnpm build:android:release
构建并安装正式版：pnpm install:android:release [--device <serial>]
正式版需要配置 NOTE_ANDROID_KEYSTORE、NOTE_ANDROID_STORE_PASSWORD、NOTE_ANDROID_KEY_ALIAS、NOTE_ANDROID_KEY_PASSWORD。
默认只构建 arm64-v8a；其他架构使用 --abi armeabi-v7a / x86_64 / x86。
手动构建全部架构及通用包：node scripts/android.mjs assembleDebug --abi all`);
  process.exit(0);
}
if (
  release &&
  ['NOTE_ANDROID_KEYSTORE', 'NOTE_ANDROID_STORE_PASSWORD', 'NOTE_ANDROID_KEY_ALIAS', 'NOTE_ANDROID_KEY_PASSWORD']
    .some((key) => !process.env[key])
)
  throw new Error(
    '正式构建需要配置 NOTE_ANDROID_KEYSTORE、NOTE_ANDROID_STORE_PASSWORD、NOTE_ANDROID_KEY_ALIAS、NOTE_ANDROID_KEY_PASSWORD。',
  );
if (!['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'all'].includes(values.abi))
  throw new Error('--abi 支持 arm64-v8a、armeabi-v7a、x86_64、x86 或 all。');
if (values.device !== undefined && (!installing || !values.device.trim()))
  throw new Error('--device 需要有效的设备序列号，且仅用于 install:android 或 install:android:release。');
const sdk = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(homedir(), 'Android/Sdk'),
  path.join(homedir(), 'Library/Android/sdk'),
].find((value) => value && existsSync(path.join(value, 'platform-tools')));
if (!sdk) throw new Error('请先安装 Android SDK，并设置 ANDROID_SDK_ROOT。');
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
let serial;
let deviceAbis = [];
if (installing) {
  // Select before building, and pass an explicit serial to every install. Never
  // delegate to Gradle installDebug, which may install on multiple devices.
  const result = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  if (result.error) throw new Error(`无法运行 adb：${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || '无法读取 Android 设备列表。');
  const devices = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\S+)\s+(device|offline|unauthorized|no permissions)\b/))
    .filter(Boolean)
    .map((match) => ({ serial: match[1], state: match[2] }));
  serial = values.device || process.env.ANDROID_SERIAL;
  if (serial) {
    const selected = devices.find((device) => device.serial === serial);
    if (selected?.state !== 'device')
      throw new Error(
        `设备 ${serial} 不可安装（${selected?.state || '未连接'}）。请检查连接及 USB 调试授权。`,
      );
  } else {
    const available = devices.filter((device) => device.state === 'device');
    if (available.length !== 1) {
      const details = devices.map((device) => `${device.serial} (${device.state})`).join(', ');
      throw new Error(
        available.length > 1
          ? `检测到多个可用设备：${details}。请用 pnpm ${installCommand} --device <序列号> 指定。`
          : `未找到可安装设备。请连接手机并授权 USB 调试，或启动模拟器。${details ? `当前设备：${details}` : ''}`,
      );
    }
    serial = available[0].serial;
  }
  const abiResult = spawnSync(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abilist'], {
    encoding: 'utf8',
  });
  if (abiResult.error || abiResult.status !== 0)
    throw new Error('无法读取设备 CPU 架构，请检查设备连接。');
  deviceAbis = abiResult.stdout.trim().split(',').filter(Boolean);
  if (values.abi !== 'all' && !deviceAbis.includes(values.abi))
    throw new Error(`设备不支持 ${values.abi}，请使用 --abi 指定设备支持的架构：${deviceAbis.join(', ')}。`);
  console.log(`安装目标：${serial}（${deviceAbis.join(', ') || '通用包'}）`);
  // npm and pnpm both expose their own CLI entry point when running a script.
  // Reuse it so pnpm install:android keeps the current package-manager context.
  if (process.env.npm_execpath) {
    await run(process.execPath, [process.env.npm_execpath, 'run', 'build:android']);
  } else {
    await run(process.platform === 'win32' ? 'cmd.exe' : 'npm', [
      ...(process.platform === 'win32' ? ['/d', '/c', 'npm'] : []),
      'run',
      'build:android',
    ]);
  }
}
await writeFile(
  'android/local.properties',
  `sdk.dir=${sdk.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`,
);
await run(
  process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  [
    ...(process.platform === 'win32' ? ['/d', '/c', 'gradlew.bat'] : []),
    installing ? (release ? 'assembleRelease' : 'assembleDebug') : task,
    '--console=plain',
    `-PnoteAbi=${values.abi}`,
  ],
  {
    cwd: 'android',
    stdio: 'inherit',
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  },
);
if (task === 'assembleDebug' || task === 'assembleRelease' || installing) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const variant = release ? 'release' : 'debug';
  const apkDir = `android/app/build/outputs/apk/${variant}`;
  const { elements } = JSON.parse(await readFile(`${apkDir}/output-metadata.json`, 'utf8'));
  const outputs = new Map();
  await mkdir('artifacts', { recursive: true });
  for (const element of elements) {
    const abi = element.filters.find((filter) => filter.filterType === 'ABI')?.value;
    const output = `artifacts/yejian-${version}-android-${abi ? `${abi}-` : ''}${variant}.apk`;
    await copyFile(path.join(apkDir, element.outputFile), output);
    outputs.set(abi || 'universal', path.resolve(output));
    console.log(`APK (${abi || 'universal'}): ${path.resolve(output)}`);
  }
  if (variant === 'release') {
    const mapping = `artifacts/yejian-${version}-android-${values.abi}-release-mapping.txt`;
    await copyFile('android/app/build/outputs/mapping/release/mapping.txt', mapping);
    console.log(`R8 mapping: ${path.resolve(mapping)}`);
  }
  if (installing) {
    const selectedAbi = deviceAbis.find((abi) => outputs.has(abi)) || 'universal';
    const output = outputs.get(selectedAbi);
    if (!output) throw new Error('构建结果中没有兼容此设备的 APK。');
    await run(adb, ['-s', serial, 'install', '-r', output]);
    console.log(`已安装页间 ${version} 到 ${serial}（${selectedAbi}）`);
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
