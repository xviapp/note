import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Exercise the command against disposable SDK/build tools, never a real device.
// The fixture executables use POSIX shebangs, like the checked-in gradlew.
const cliTest = (name, run) => test(name, { skip: process.platform === 'win32' }, run);
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yejian-android-cli-'));
  const sdk = path.join(root, 'sdk');
  const log = path.join(root, 'calls.jsonl');
  const helper = `import fs from 'node:fs';
const args = process.argv.slice(2);
const record = name => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ name, args }) + '\\n');
`;
  try {
    for (const dir of ['scripts', 'android', 'sdk/platform-tools'])
      await mkdir(path.join(root, dir), { recursive: true });
    await copyFile(
      new URL('./android.mjs', import.meta.url),
      path.join(root, 'scripts/android.mjs'),
    );
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ version: '0.2.1', type: 'module' }),
    );
    await writeFile(log, '');
    await writeFile(
      path.join(sdk, 'platform-tools/adb'),
      `#!/usr/bin/env node
${helper}
record('adb');
if (args[0] === 'devices') console.log('List of devices attached\\n' + process.env.FIXTURE_DEVICES);
else if (args.includes('getprop')) console.log(process.env.FIXTURE_ABIS ?? 'arm64-v8a,armeabi-v7a');
else process.exit(Number(process.env.FIXTURE_INSTALL_EXIT || 0));
`,
      { mode: 0o755 },
    );
    const manager = path.join(root, 'package-manager.mjs');
    await writeFile(
      manager,
      `${helper}
record('frontend');
process.exit(Number(process.env.FIXTURE_BUILD_EXIT || 0));
`,
    );
    await writeFile(
      path.join(root, 'android/gradlew'),
      `#!/usr/bin/env node
${helper}
record('gradle');
if (process.env.FIXTURE_GRADLE_EXIT) process.exit(Number(process.env.FIXTURE_GRADLE_EXIT));
const variant = args[0] === 'assembleRelease' ? 'release' : 'debug';
fs.mkdirSync('app/build/outputs/apk/' + variant, { recursive: true });
const requestedAbi = args.find(arg => arg.startsWith('-PnoteAbi=')).split('=')[1];
const elements = (requestedAbi === 'all' ? ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', null] : [requestedAbi]).map(abi => ({
  filters: abi ? [{ filterType: 'ABI', value: abi }] : [],
  outputFile: 'app-' + (abi ? abi + '-' : 'universal-') + variant + '.apk',
}));
for (const element of elements)
  fs.writeFileSync('app/build/outputs/apk/' + variant + '/' + element.outputFile, 'fresh APK');
fs.writeFileSync('app/build/outputs/apk/' + variant + '/output-metadata.json', JSON.stringify({ elements }));
if (variant === 'release') {
  fs.mkdirSync('app/build/outputs/mapping/release', { recursive: true });
  fs.writeFileSync('app/build/outputs/mapping/release/mapping.txt', 'matching R8 mapping');
}
`,
      { mode: 0o755 },
    );
    await run({
      root,
      execute: async (args = [], env = {}, task = 'install') => {
        await writeFile(log, '');
        const result = spawnSync(process.execPath, ['scripts/android.mjs', task, ...args], {
          cwd: root,
          env: {
            ...process.env,
            ANDROID_SDK_ROOT: sdk,
            ANDROID_SERIAL: '',
            npm_execpath: manager,
            FIXTURE_LOG: log,
            FIXTURE_DEVICES: 'phone-one\tdevice',
            ...env,
          },
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.ifError(result.error);
        const calls = (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse);
        return { ...result, calls };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

cliTest('builds and installs a fresh APK only on the one selected device', () =>
  fixture(async ({ execute, root }) => {
    const result = await execute();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call.name),
      ['adb', 'adb', 'frontend', 'gradle', 'adb'],
    );
    assert.deepEqual(result.calls[2].args, ['run', 'build:android']);
    assert.deepEqual(result.calls[3].args, ['assembleDebug', '--console=plain', '-PnoteAbi=arm64-v8a']);
    const apk = path.join(root, 'artifacts/yejian-0.2.1-android-arm64-v8a-debug.apk');
    assert.deepEqual(result.calls[4].args, ['-s', 'phone-one', 'install', '-r', apk]);
    assert.equal(await readFile(apk, 'utf8'), 'fresh APK');
  }),
);

cliTest('release installation checks signing, builds the selected ABI and installs only the release APK', () =>
  fixture(async ({ execute, root }) => {
    const missing = await execute([], { NOTE_ANDROID_KEYSTORE: '' }, 'installRelease');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /NOTE_ANDROID_KEYSTORE/);
    assert.deepEqual(missing.calls, []);
    const help = await execute(['--help'], { NOTE_ANDROID_KEYSTORE: '' }, 'installRelease');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /pnpm install:android:release/);
    assert.deepEqual(help.calls, []);
    const env = {
      NOTE_ANDROID_KEYSTORE: path.join(root, 'fixture.jks'),
      NOTE_ANDROID_STORE_PASSWORD: 'fixture-only',
      NOTE_ANDROID_KEY_ALIAS: 'fixture',
      NOTE_ANDROID_KEY_PASSWORD: 'fixture-only',
      FIXTURE_DEVICES: 'phone-one\tdevice\nemulator-one\tdevice',
      FIXTURE_ABIS: 'x86_64,x86',
    };
    const args = ['--device', 'emulator-one', '--abi', 'x86_64'];
    const result = await execute(args, env, 'installRelease');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.name), ['adb', 'adb', 'frontend', 'gradle', 'adb']);
    assert.deepEqual(result.calls[2].args, ['run', 'build:android']);
    assert.deepEqual(result.calls[3].args, ['assembleRelease', '--console=plain', '-PnoteAbi=x86_64']);
    const apk = path.join(root, 'artifacts/yejian-0.2.1-android-x86_64-release.apk');
    assert.deepEqual(result.calls[4].args, ['-s', 'emulator-one', 'install', '-r', apk]);
    assert.equal(await readFile(apk, 'utf8'), 'fresh APK');
    assert.equal(await readFile(path.join(root, 'artifacts/yejian-0.2.1-android-x86_64-release-mapping.txt'), 'utf8'), 'matching R8 mapping');
    const failed = await execute(args, { ...env, FIXTURE_GRADLE_EXIT: '8' }, 'installRelease');
    assert.equal(failed.status, 8);
    assert.deepEqual(failed.calls.map(call => call.name), ['adb', 'adb', 'frontend', 'gradle']);
  }),
);

cliTest('release refuses missing signing configuration and copies the signed build variant', () =>
  fixture(async ({ execute, root }) => {
    const missing = await execute([], { NOTE_ANDROID_KEYSTORE: '' }, 'assembleRelease');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /NOTE_ANDROID_KEYSTORE/);
    assert.deepEqual(missing.calls, []);
    const release = await execute(
      [],
      {
        NOTE_ANDROID_KEYSTORE: path.join(root, 'fixture.jks'),
        NOTE_ANDROID_STORE_PASSWORD: 'fixture-only',
        NOTE_ANDROID_KEY_ALIAS: 'fixture',
        NOTE_ANDROID_KEY_PASSWORD: 'fixture-only',
      },
      'assembleRelease',
    );
    assert.equal(release.status, 0, release.stderr);
    assert.deepEqual(release.calls, [
      { name: 'gradle', args: ['assembleRelease', '--console=plain', '-PnoteAbi=arm64-v8a'] },
    ]);
    assert.equal(
      await readFile(path.join(root, 'artifacts/yejian-0.2.1-android-arm64-v8a-release.apk'), 'utf8'),
      'fresh APK',
    );
    assert.equal(
      await readFile(path.join(root, 'artifacts/yejian-0.2.1-android-arm64-v8a-release-mapping.txt'), 'utf8'),
      'matching R8 mapping',
    );
  }),
);

cliTest('loads release signing values from the ignored local env file', () =>
  fixture(async ({ execute, root }) => {
    await writeFile(
      path.join(root, '.env'),
      `NOTE_ANDROID_KEYSTORE="${path.join(root, 'fixture.jks')}"\nNOTE_ANDROID_STORE_PASSWORD=fixture-only\nNOTE_ANDROID_KEY_ALIAS=fixture\nNOTE_ANDROID_KEY_PASSWORD=fixture-only\n`,
    );
    const result = await execute([], {}, 'assembleRelease');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      { name: 'gradle', args: ['assembleRelease', '--console=plain', '-PnoteAbi=arm64-v8a'] },
    ]);
  }),
);

for (const [label, devices, message] of [
  ['no connected device', '', /未找到可安装设备/],
  ['multiple ready devices', 'phone-one\tdevice\nemulator-one\tdevice', /多个可用设备/],
  ['unauthorized or offline devices', 'phone-one\tunauthorized\nemulator-one\toffline', /USB 调试/],
])
  cliTest(`${label} stops before building or installing`, () =>
    fixture(async ({ execute }) => {
      const result = await execute([], { FIXTURE_DEVICES: devices });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.deepEqual(result.calls, [{ name: 'adb', args: ['devices'] }]);
    }),
  );

cliTest('explicit serial overrides ANDROID_SERIAL and both resolve only ready devices', () =>
  fixture(async ({ execute }) => {
    const env = {
      FIXTURE_DEVICES: 'phone-one\tdevice\nemulator-one\tdevice\nold-phone\toffline',
      ANDROID_SERIAL: 'phone-one',
    };
    const explicit = await execute(['--device', 'emulator-one'], env);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.calls.at(-1).args[1], 'emulator-one');
    const inherited = await execute([], env);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.calls.at(-1).args[1], 'phone-one');
    for (const serial of ['old-phone', 'missing-phone']) {
      const unavailable = await execute(['--device', serial], env);
      assert.notEqual(unavailable.status, 0);
      assert.deepEqual(unavailable.calls, [{ name: 'adb', args: ['devices'] }]);
    }
  }),
);

cliTest('failed frontend or Gradle build never installs an old APK; adb failures propagate', () =>
  fixture(async ({ execute, root }) => {
    await mkdir(path.join(root, 'android/app/build/outputs/apk/debug'), { recursive: true });
    await writeFile(
      path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'),
      'old APK',
    );
    const frontend = await execute([], { FIXTURE_BUILD_EXIT: '7' });
    assert.equal(frontend.status, 7);
    assert.deepEqual(
      frontend.calls.map((call) => call.name),
      ['adb', 'adb', 'frontend'],
    );
    const gradle = await execute([], { FIXTURE_GRADLE_EXIT: '8' });
    assert.equal(gradle.status, 8);
    assert.deepEqual(
      gradle.calls.map((call) => call.name),
      ['adb', 'adb', 'frontend', 'gradle'],
    );
    const install = await execute([], { FIXTURE_INSTALL_EXIT: '9' });
    assert.equal(install.status, 9);
    assert.doesNotMatch(install.stdout, /已安装页间/);
  }),
);

cliTest('copies every architecture and selects the first compatible ABI or universal fallback', () =>
  fixture(async ({ execute, root }) => {
    for (const [abis, expected] of [
      ['x86_64,x86', 'x86_64-'],
      ['armeabi-v7a', 'armeabi-v7a-'],
      ['unknown', ''],
    ]) {
      const result = await execute(['--abi', 'all'], { FIXTURE_ABIS: abis });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.at(-1).args.at(-1),
        path.join(root, `artifacts/yejian-0.2.1-android-${expected}debug.apk`));
    }
    for (const abi of ['arm64-v8a-', 'armeabi-v7a-', 'x86_64-', 'x86-', ''])
      assert.equal(await readFile(path.join(root, `artifacts/yejian-0.2.1-android-${abi}debug.apk`), 'utf8'), 'fresh APK');
  }),
);

cliTest('other architectures require explicit selection; incompatible defaults stop before building', () =>
  fixture(async ({ execute }) => {
    const incompatible = await execute([], { FIXTURE_ABIS: 'x86_64,x86' });
    assert.notEqual(incompatible.status, 0);
    assert.match(incompatible.stderr, /--abi/);
    assert.deepEqual(incompatible.calls.map(call => call.name), ['adb', 'adb']);
    const selected = await execute(['--abi', 'x86_64'], { FIXTURE_ABIS: 'x86_64,x86' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.calls.at(-1).args.at(-1), /android-x86_64-debug\.apk$/);
  }),
);
