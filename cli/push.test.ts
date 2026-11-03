import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportContentKey,
  fromBase64Url,
  keyCheck,
  newContentKey,
  newSalt,
  openBytes,
  passwordKey,
  sealBytes,
  sealedKeyId,
  toBase64Url,
  wrapContentKey,
} from '../shared/encryption.ts';
import { findChanges } from './changes.ts';
import { Client } from './client.ts';
import { FakeServer } from './fake-server.ts';
import { Keyring } from './keys.ts';
import { pull } from './pull.ts';
import { Pusher, resolveConflict } from './push.ts';
import { Workspace, type State } from './workspace.ts';

const SERVER = 'https://note.test';
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
describe('push', () => {
  let dir: string, fake: FakeServer, client: Client, password: string | null;
  const ask = async () => password;
  const write = async (path: string, text: string | Uint8Array) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  const read = (path: string) => readFile(join(dir, path), 'utf8');
  const down = (root: string | null = null, decrypt = false) =>
    pull({ client, dir, root, pdf: false, decrypt, ask });
  const up = async (deletes = false) => {
    const workspace = new Workspace(dir);
    const state = (await workspace.loadState()) as State;
    const changes = await findChanges(workspace, state);
    const keyring = state.decrypt ? new Keyring(client, ask) : null;
    const report = await new Pusher(client, workspace, state, changes, keyring).run({ deletes });
    await workspace.saveState(state);
    return { report, changes, state };
  };
  const pending = async () => {
    const workspace = new Workspace(dir);
    return findChanges(workspace, (await workspace.loadState())!);
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xvi-push-'));
    fake = new FakeServer();
    client = new Client(SERVER, 'token', fake.fetcher, 0);
    password = null;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reports nothing after a pull, and writes nothing', async () => {
    fake.files.set('img', png);
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      {
        id: 'n',
        parent: 'f',
        kind: 'markdown',
        title: '笔记',
        content: 'a\r\n![图](/api/files/img) /api/files/none ![q](/api/files/img?download=1)\n',
        attachments: [{ id: 'img', name: 'a.png', mime: 'image/png', size: png.length }],
      },
      { id: 't', parent: 'n', kind: 'text', title: '下级', content: '' },
    ];
    await down();
    const changes = await pending();
    expect(changes).toMatchObject({ edits: [], creates: [], moves: [], deletes: [], ignored: [] });
    fake.calls = [];
    await up();
    expect(fake.calls.filter((call) => !call.startsWith('/'))).toEqual([]);
  });
  it('sends an edit with file links restored and the note read-write checked', async () => {
    fake.files.set('img', png);
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      {
        id: 'n',
        parent: 'f',
        kind: 'markdown',
        title: '笔记',
        content: '![图](/api/files/img)',
        attachments: [{ id: 'img', name: 'a.png', mime: 'image/png', size: png.length }],
      },
    ];
    await down();
    await write('目录/笔记.md', '![图](../.xvi/files/img.png)\n新增\n');
    const { report, state } = await up();
    expect(report.saved).toEqual(['目录/笔记.md']);
    expect(fake.get('n')).toMatchObject({ content: '![图](/api/files/img)\n新增\n', revision: 2 });
    expect(state.entries.n.revision).toBe(2);
    expect((await pending()).edits).toEqual([]);
  });
  it('keeps attachments the note holds without linking them', async () => {
    fake.files.set('img', png);
    fake.nodes = [
      {
        id: 'n',
        parent: null,
        kind: 'markdown',
        title: 'a',
        content: '无链接',
        attachments: [{ id: 'img', name: 'a.png', mime: 'image/png', size: png.length }],
      },
    ];
    await down();
    await write('a.md', '仍无链接');
    await up();
    expect(fake.get('n').attachments!.map((file) => file.id)).toEqual(['img']);
  });
  it('turns relative links into note links and uploads new images', async () => {
    fake.nodes = [
      { id: 'a', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'b', parent: null, kind: 'markdown', title: 'b', content: '二' },
    ];
    await down();
    await write('图/新.png', png);
    await write(
      'a.md',
      '[去 b](b.md)\n![新](图/新.png)\n![无](没有.png)\n[外](https://x.test/b.md)\n`![码](图/新.png)`\n[越界](../../etc/passwd)\n',
    );
    const { report } = await up();
    expect(fake.uploads.map((item) => item.name)).toEqual(['新.png']);
    expect(fake.get('a').content).toBe(
      '[去 b](/n/b)\n![新](/api/files/up1)\n![无](没有.png)\n[外](https://x.test/b.md)\n`![码](图/新.png)`\n[越界](../../etc/passwd)\n',
    );
    expect(report.warnings.join()).toContain('没有.png');
    expect(report.warnings.join()).toContain('../../etc/passwd');
    // The local file now reads as a pull would have written it.
    expect(await read('a.md')).toContain('![新](.xvi/files/up1.png)');
    expect((await pending()).edits).toEqual([]);
  });
  it('saves the server copy beside a conflicting edit and writes after resolve', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '原文' }];
    await down();
    await write('a.md', '本地');
    Object.assign(fake.get('n'), { content: '远端', revision: 2 });
    const { report } = await up();
    expect(report).toMatchObject({ conflicts: ['a.md'], saved: [] });
    expect(fake.get('n').content).toBe('远端');
    expect(await read('a.md')).toBe('本地');
    expect(await read('a.remote.md')).toBe('远端');
    // Nothing goes out until it is resolved, and the conflict file is no new note.
    const waiting = await pending();
    expect(waiting).toMatchObject({ conflicts: ['a.md'], edits: [], creates: [] });
    await write('a.md', '合并');
    const workspace = new Workspace(dir);
    await resolveConflict(workspace, (await workspace.loadState())!, 'a.md');
    await expect(stat(join(dir, 'a.remote.md'))).rejects.toThrow();
    expect((await up()).report.saved).toEqual(['a.md']);
    expect(fake.get('n')).toMatchObject({ content: '合并', revision: 3 });
  });
  it('treats a save refused for its revision as a conflict', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '原文' }];
    await down();
    await write('a.md', '本地');
    const original = fake.fetcher;
    fake.fetcher = async (input, init) => {
      // Changed between this push reading the note and saving it.
      if (String(input).endsWith('/api/edit/unlock'))
        Object.assign(fake.get('n'), { content: '抢先', revision: 2 });
      return original(input, init);
    };
    client = new Client(SERVER, 'token', fake.fetcher, 0);
    expect((await up()).report.conflicts).toEqual(['a.md']);
    expect(fake.get('n').content).toBe('抢先');
    expect(await read('a.remote.md')).toBe('抢先');
  });
  it('writes past a change to the note\'s details alone', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '原文' }];
    await down();
    await write('a.md', '本地');
    fake.get('n').revision = 5;
    expect((await up()).report.saved).toEqual(['a.md']);
    expect(fake.get('n')).toMatchObject({ content: '本地', revision: 6 });
  });
  it('repeats an edit safely after losing the response', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '原文' }];
    await down();
    await write('a.md', '本地');
    fake.loseNextResponse = true;
    expect((await up()).report.failed[0].message).toContain('连接中断');
    expect(fake.get('n').revision).toBe(2);
    // The note's revision moved on by this very edit; the local file already matches.
    const again = await up();
    expect(again.report.failed).toEqual([]);
    expect(again.report.conflicts).toEqual([]);
    expect(fake.get('n').revision).toBe(2);
    expect((await pending()).edits).toEqual([]);
  });
  it('creates notes and the folders they need, once even when the response is lost', async () => {
    fake.nodes = [{ id: 'f', parent: null, kind: 'folder', title: '目录' }];
    await down();
    await write('目录/新/更深/笔记.md', '正文');
    await write('目录/新/更深/文本.txt', '文本');
    await write('顶层.md', '顶');
    fake.loseNextResponse = true;
    const first = await up();
    expect(first.report.failed).toHaveLength(1);
    const count = fake.nodes.length;
    const { report } = await up();
    expect(report.failed).toEqual([]);
    expect(fake.nodes.length).toBe(count);
    expect(fake.nodes.filter((node) => node.title === '新')).toHaveLength(1);
    const made = fake.find('笔记');
    expect(made).toMatchObject({ kind: 'markdown', content: '正文' });
    expect(fake.get(made.parent!).title).toBe('更深');
    expect(fake.find('文本').kind).toBe('text');
    expect(fake.find('顶层').parent).toBeNull();
    expect((await pending()).creates).toEqual([]);
  });
  it('keeps a new edit made after a create whose response was lost', async () => {
    await down();
    await write('新.md', '第一稿');
    fake.loseNextResponse = true;
    await up();
    await write('新.md', '第二稿');
    expect((await up()).report.failed).toEqual([]);
    expect(await read('新.md')).toBe('第二稿');
    expect((await pending()).edits).toEqual(['新.md']);
    await up();
    expect(fake.find('新').content).toBe('第二稿');
  });
  it('places a new child under the note beside its directory', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: '项目', content: '一' }];
    await down();
    await write('项目/子.md', '二');
    await up();
    expect(fake.find('子').parent).toBe('n');
  });
  it('refuses a new file outside the synced subtree', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: '项目', content: '一' }];
    await down('n');
    await write('外面.md', '二');
    const { report } = await up();
    expect(report.failed[0].message).toContain('之外');
    expect(fake.find('外面')).toBeUndefined();
  });
  it('renames and moves a note, keeping its title when only the place changes', async () => {
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      { id: 'a', parent: 'f', kind: 'markdown', title: '项目/计划', content: '搬家' },
      { id: 'b', parent: 'f', kind: 'markdown', title: '旧名', content: '改名' },
    ];
    await down();
    await rename(join(dir, '目录/项目_计划.md'), join(dir, '项目_计划.md'));
    await rename(join(dir, '目录/旧名.md'), join(dir, '目录/新名.md'));
    const { report } = await up();
    expect(report.moved.sort()).toEqual(['目录/旧名.md → 目录/新名.md', '目录/项目_计划.md → 项目_计划.md']);
    expect(fake.get('a')).toMatchObject({ parent: null, title: '项目/计划', content: '搬家' });
    expect(fake.get('b')).toMatchObject({ parent: 'f', title: '新名', revision: 2 });
    expect(fake.calls.filter((call) => call.includes('/content'))).toEqual([]);
    const after = await pending();
    expect(after).toMatchObject({ moves: [], deletes: [], creates: [] });
  });
  it('rewrites a moved note\'s file links for its new depth', async () => {
    fake.files.set('img', png);
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      {
        id: 'n',
        parent: 'f',
        kind: 'markdown',
        title: '笔记',
        content: '![](/api/files/img)',
        attachments: [{ id: 'img', name: 'a.png', mime: 'image/png', size: png.length }],
      },
    ];
    await down();
    expect(await read('目录/笔记.md')).toBe('![](../.xvi/files/img.png)');
    await rename(join(dir, '目录/笔记.md'), join(dir, '笔记.md'));
    await up();
    expect(await read('笔记.md')).toBe('![](.xvi/files/img.png)');
    expect(fake.get('n').content).toBe('![](/api/files/img)');
    expect(await pending()).toMatchObject({ edits: [], moves: [] });
  });
  it('renames a folder as one, not its contents one by one', async () => {
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: 'v1.2' },
      { id: 's', parent: 'f', kind: 'folder', title: '内层' },
      { id: 'a', parent: 'f', kind: 'markdown', title: 'a', content: '同样' },
      { id: 'b', parent: 'f', kind: 'markdown', title: 'b', content: '同样' },
      { id: 'c', parent: 's', kind: 'markdown', title: 'c', content: '独有' },
      { id: 'd', parent: 'f', kind: 'markdown', title: 'd', content: '另一个' },
    ];
    await down();
    await rename(join(dir, 'v1.2'), join(dir, 'v1.3'));
    const { report } = await up();
    expect(report.failed).toEqual([]);
    expect(report.moved).toEqual(['v1.2 → v1.3']);
    expect(fake.get('f')).toMatchObject({ title: 'v1.3', revision: 2 });
    for (const id of ['a', 'b', 'c', 'd', 's']) expect(fake.get(id).revision ?? 1).toBe(1);
    expect(await pending()).toMatchObject({ moves: [], deletes: [], creates: [] });
    await down();
    expect(await read('v1.3/内层/c.md')).toBe('独有');
  });
  it('does not take an edit and a rename together for a move', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '原文' }];
    await down();
    await rm(join(dir, 'a.md'));
    await write('b.md', '改过');
    const changes = await pending();
    expect(changes.moves).toEqual([]);
    expect(changes.creates).toEqual(['b.md']);
    expect(changes.deletes).toEqual([{ id: 'n', count: 1 }]);
  });
  it('does not guess between identical copies', async () => {
    fake.nodes = [
      { id: 'a', parent: null, kind: 'markdown', title: 'a', content: '同样' },
      { id: 'b', parent: null, kind: 'markdown', title: 'b', content: '同样' },
    ];
    await down();
    await rename(join(dir, 'a.md'), join(dir, 'x.md'));
    await rename(join(dir, 'b.md'), join(dir, 'y.md'));
    expect((await pending()).moves).toEqual([]);
  });
  it('blocks moves it cannot make safely', async () => {
    fake.nodes = [
      { id: 'b', parent: null, kind: 'folder', title: '书', variant: 'book' },
      { id: 'p', parent: 'b', kind: 'markdown', title: '第一页', variant: 'book-page', content: '页' },
      { id: 'k', parent: null, kind: 'folder', title: '锁', key_id: 'k1' },
      { id: 'n', parent: null, kind: 'markdown', title: '明文', content: '明' },
    ];
    await down();
    await rename(join(dir, '书/第一页.md'), join(dir, '第一页.md'));
    const changes = await pending();
    expect(changes.moves).toEqual([]);
    expect(changes.blocked[0].reason).toContain('书页');
  });
  it('refuses a move across an encryption boundary', async () => {
    fake.nodes = [
      { id: 's', parent: null, kind: 'folder', title: '锁', key_id: 'k1' },
      { id: 'n', parent: null, kind: 'markdown', title: '明文', content: '明' },
    ];
    await down();
    const workspace = new Workspace(dir);
    const state = (await workspace.loadState())!;
    // As if the folder had been pulled decrypted.
    state.entries.s = { kind: 'folder', title: '锁', path: '锁', revision: 1, parent: null, key_id: 'k1' };
    await workspace.saveState(state);
    await rename(join(dir, '明文.md'), join(await mk('锁'), '明文.md'));
    const { report } = await up();
    expect(report.failed[0].message).toContain('加密范围');
    expect(fake.get('n').parent).toBeNull();
    async function mk(name: string) {
      await mkdir(join(dir, name));
      return join(dir, name);
    }
  });
  it('blocks moving or removing the synced root', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: '根', content: '一' }];
    await down('n');
    await rm(join(dir, '根.md'));
    expect((await pending()).blocked[0].reason).toContain('根条目');
    await down('n');
    await rename(join(dir, '根.md'), join(dir, '改.md'));
    expect((await pending()).blocked[0].reason).toContain('根条目');
  });
  it('leaves deletes alone unless asked', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await down();
    await rm(join(dir, 'a.md'));
    expect((await up()).report.trashed).toEqual([]);
    expect(fake.get('n').trashed).toBeFalsy();
    await down();
    expect(await read('a.md')).toBe('一');
  });
  it('trashes a removed subtree once, from its top', async () => {
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      { id: 'a', parent: 'f', kind: 'markdown', title: 'a', content: '一' },
      { id: 'b', parent: 'a', kind: 'markdown', title: 'b', content: '二' },
    ];
    await down();
    await rm(join(dir, '目录'), { recursive: true });
    const { report, state } = await up(true);
    expect(report.trashed).toEqual(['目录']);
    expect(fake.calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE /api/nodes/f']);
    expect(fake.get('b').trashed).toBe(true);
    expect(Object.keys(state.entries)).toEqual([]);
  });
  it('will not delete a note whose children are still here', async () => {
    fake.nodes = [
      { id: 'a', parent: null, kind: 'markdown', title: 'a', content: '一' },
      { id: 'b', parent: 'a', kind: 'markdown', title: 'b', content: '二' },
    ];
    await down();
    await rm(join(dir, 'a.md'));
    const { report, changes } = await up(true);
    expect(changes.blocked[0].reason).toContain('下级');
    expect(report.trashed).toEqual([]);
    expect(fake.get('a').trashed).toBeFalsy();
  });
  it('will not delete what it has not seen', async () => {
    fake.nodes = [
      { id: 'f', parent: null, kind: 'folder', title: '目录' },
      { id: 'k', parent: 'f', kind: 'markdown', title: '加密下级', key_id: 'k1' },
      { id: 'a', parent: 'f', kind: 'markdown', title: 'a', content: '一' },
    ];
    await down();
    await rm(join(dir, '目录'), { recursive: true });
    const { report } = await up(true);
    expect(report.failed[0].message).toContain('3 个');
    expect(fake.get('f').trashed).toBeFalsy();
  });
  it('will not delete a note changed on the server since', async () => {
    fake.nodes = [{ id: 'a', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await down();
    await rm(join(dir, 'a.md'));
    fake.get('a').revision = 2;
    const { report } = await up(true);
    expect(report.conflicts).toEqual(['a.md']);
    expect(fake.get('a').trashed).toBeFalsy();
  });
  it('copies files shared with another note before saving', async () => {
    fake.files.set('other', png);
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await down();
    await write('a.md', '![](/api/files/other)');
    fake.sharedFiles = [{ id: 'other', name: 'o.png', mime: 'image/png' }];
    const { report } = await up();
    expect(report.failed).toEqual([]);
    expect(fake.get('n').content).toBe('![](/api/files/up1)');
  });
  it('fails cleanly on text that is not UTF-8', async () => {
    fake.nodes = [{ id: 'n', parent: null, kind: 'markdown', title: 'a', content: '一' }];
    await down();
    await write('a.md', new Uint8Array([0xff, 0xfe, 0x00]));
    expect((await up()).report.failed).toHaveLength(1);
    expect(fake.get('n').content).toBe('一');
  });
  describe('encrypted notes', () => {
    let key: CryptoKey;
    const keyId = '00000000-0000-4000-8000-000000000001';
    const sealedText = async (text: string) =>
      toBase64Url(await sealBytes(key, keyId, new TextEncoder().encode(text)));
    const openNode = async (sealed: string) =>
      new TextDecoder().decode(await openBytes(key, fromBase64Url(sealed)));
    beforeEach(async () => {
      key = await newContentKey();
      const salt = newSalt();
      fake.keys = [
        {
          id: keyId,
          salt,
          iterations: 100_000,
          wrapped: await wrapContentKey(await passwordKey('密码', salt, 100_000), await exportContentKey(key)),
          check_value: await keyCheck(key),
        },
      ];
      const sealedFile = await sealBytes(key, keyId, png);
      fake.files.set('sf', sealedFile);
      fake.nodes = [
        { id: 'f', parent: null, kind: 'folder', title: '锁', key_id: keyId },
        {
          id: 'n',
          parent: 'f',
          kind: 'markdown',
          title: '密',
          key_id: keyId,
          content: '',
          sealed: await sealedText('机密 ![](/api/files/sf)'),
          attachments: [{ id: 'sf', name: 'a.png', mime: 'image/png', size: sealedFile.length, key_id: keyId }],
        },
        { id: 'p', parent: null, kind: 'markdown', title: '明', content: '公开' },
      ];
    });
    it('stays out unless asked', async () => {
      const { report } = await down();
      expect(report.encrypted).toBe(1);
      await expect(stat(join(dir, '锁'))).rejects.toThrow();
    });
    it('decrypts bodies and attachments when asked', async () => {
      password = '密码';
      const { report } = await down(null, true);
      expect(report.failed).toEqual([]);
      expect(await read('锁/密.md')).toBe('机密 ![](../.xvi/files/sf.png)');
      expect(new Uint8Array(await readFile(join(dir, '.xvi/files/sf.png')))).toEqual(png);
    });
    it('keeps local copies when the password is skipped or wrong', async () => {
      password = '密码';
      await down(null, true);
      password = null;
      const skipped = await down();
      expect(skipped.report).toMatchObject({ locked: 1, removed: [] });
      expect(await read('锁/密.md')).toContain('机密');
      password = '错的';
      expect((await down()).report).toMatchObject({ locked: 1, removed: [] });
      expect(await read('锁/密.md')).toContain('机密');
    });
    it('removes a plain copy once a note is encrypted, in a workspace without keys', async () => {
      await down();
      expect(await read('明.md')).toBe('公开');
      Object.assign(fake.get('p'), { key_id: keyId, revision: 2 });
      expect((await down()).report.removed).toEqual(['明.md']);
    });
    it('seals edits, new notes and images, sending no plain text', async () => {
      password = '密码';
      await down(null, true);
      await write('锁/密.md', '机密 ![](../.xvi/files/sf.png)\n加密改动 SECRET\n![新](新.png)\n');
      await write('锁/新.png', png);
      await write('锁/新建.md', '---\ntitle: 文首\n---\n新建 SECRET\n');
      const bodies: string[] = [];
      const original = fake.fetcher;
      client = new Client(
        SERVER,
        'token',
        async (input, init) => {
          bodies.push(typeof init?.body === 'string' ? init.body : Buffer.from((init?.body as Uint8Array) ?? []).toString('latin1'));
          return original(input, init);
        },
        0,
      );
      const { report } = await up();
      expect(report.failed).toEqual([]);
      expect(bodies.join()).not.toContain('SECRET');
      expect(bodies.join()).not.toContain('文首');
      for (const upload of fake.uploads) {
        expect(upload.key).toBe(keyId);
        expect(sealedKeyId(upload.bytes)).toBe(keyId);
      }
      const note = fake.get('n');
      expect(note.content).toBe('');
      expect(await openNode(note.sealed!)).toContain('加密改动 SECRET');
      expect(await openNode(fake.find('新建').sealed!)).toContain('新建 SECRET');
      expect(await read('锁/密.md')).toContain('加密改动 SECRET');
      expect((await pending()).edits).toEqual([]);
    });
    it('will not upload an SVG into an encrypted place', async () => {
      password = '密码';
      await down(null, true);
      await write('锁/图.svg', '<svg/>');
      await write('锁/密.md', '![](图.svg)');
      const { report } = await up();
      expect(fake.uploads.filter((item) => item.name === '图.svg')).toEqual([]);
      expect(report.warnings.join()).toContain('图.svg');
    });
    it('refuses to send plain text to a note encrypted since the pull', async () => {
      await down();
      await write('明.md', '改动');
      Object.assign(fake.get('p'), {
        key_id: keyId,
        sealed: await sealedText('公开'),
        content: '',
        revision: 2,
      });
      const { report } = await up();
      expect(report.failed[0].message).toContain('加密');
      expect(fake.get('p').content).toBe('');
    });
    it('does not ask for a password to look at status-level changes', async () => {
      password = '密码';
      await down(null, true);
      await write('新.md', '明文新建');
      password = null;
      const { report } = await up();
      expect(report.created).toEqual(['新.md']);
    });
  });
});
