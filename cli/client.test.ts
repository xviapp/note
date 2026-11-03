import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivePasswordHash } from '../shared/password.ts';
import { ApiError, Client, loadCredentials, saveCredentials, serverOrigin } from './client.ts';
import { resolveTarget } from './target.ts';

const SERVER = 'https://note.test';
const SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers });
describe('serverOrigin', () => {
  it('assumes HTTPS and refuses plain HTTP except locally', () => {
    expect(serverOrigin('note.test/n/x')).toBe(SERVER);
    expect(serverOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => serverOrigin('http://note.test')).toThrow('HTTPS');
  });
});
describe('login', () => {
  it('sends a derived proof with the site origin and keeps the session', async () => {
    let sent: { password: { derived: string; salt: string; iterations: number; length: number } };
    let origin: string | null = null;
    const steps: string[] = [];
    const client = new Client(SERVER, null, async (input, init) => {
      const path = new URL(String(input)).pathname;
      const seen = new Headers(init?.headers);
      if (path.endsWith('/status'))
        return json({
          initialized: true,
          password: { salt: SALT, iterations: 10, clientHash: true },
        });
      if (path === '/api/tokens') {
        steps.push(`token ${seen.get('cookie')} ${init?.body}`);
        return json({ id: 't', token: 'xvi_abc' }, 201);
      }
      if (path === '/api/auth/logout') {
        steps.push(`logout ${seen.get('cookie')}`);
        return json({ ok: true });
      }
      origin = seen.get('origin');
      sent = JSON.parse(String(init?.body));
      const headers = new Headers();
      headers.append('set-cookie', 'note_session=abc; Path=/; HttpOnly');
      headers.append('set-cookie', 'note_device=def; Path=/api/auth/');
      return json({ ok: true }, 200, headers);
    });
    await client.login('密码12345', '电脑', 'read');
    expect(client.token).toBe('xvi_abc');
    // The session only lives long enough to make the token.
    expect(steps).toEqual([
      'token note_session=abc {"name":"电脑","scope":"read"}',
      'logout note_session=abc',
    ]);
    expect(origin).toBe(SERVER);
    expect(sent!.password).toEqual({
      derived: await derivePasswordHash('密码12345', SALT, 10),
      salt: SALT,
      iterations: 10,
      length: 7,
    });
  });
  it('reports a wrong password as such', async () => {
    const client = new Client(SERVER, null, async (input) =>
      String(input).endsWith('/status')
        ? json({ initialized: true, password: { salt: SALT, iterations: 10, clientHash: true } })
        : json({ error: '密码不正确，请重新输入。', code: 'INVALID_PASSWORD' }, 401),
    );
    await expect(client.login('错误密码1234', '电脑', 'write')).rejects.toThrow('密码不正确');
  });
});
describe('requests', () => {
  it('retries a busy server, not a missing note', async () => {
    const statuses = [503, 200],
      calls: string[] = [];
    const client = new Client(
      SERVER,
      's',
      async (input) => {
        calls.push(String(input));
        return String(input).endsWith('/gone')
          ? json({ error: '不存在' }, 404)
          : json({ id: 'a' }, statuses.shift());
      },
      0,
    );
    await expect(client.node('a')).resolves.toMatchObject({ id: 'a' });
    expect(calls).toHaveLength(2);
    await expect(client.node('gone')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(3);
  });
  it('tells the user to sign in again', async () => {
    const client = new Client(SERVER, 's', async () => json({ error: 'x', code: 'UNAUTHENTICATED' }, 401));
    await expect(client.children(null)).rejects.toThrow('xvi login');
  });
  it('sends the token and follows pages', async () => {
    const seen: string[] = [];
    const client = new Client(SERVER, 's', async (input, init) => {
      seen.push(`${new URL(String(input)).search} ${new Headers(init?.headers).get('authorization')}`);
      return json(
        String(input).includes('offset=0')
          ? { nodes: [{ id: 'a' }], nextOffset: 100 }
          : { nodes: [{ id: 'b' }], nextOffset: null },
      );
    });
    expect((await client.children('p')).map((node) => node.id)).toEqual(['a', 'b']);
    expect(seen).toEqual([
      '?offset=0&parent=p Bearer s',
      '?offset=100&parent=p Bearer s',
    ]);
  });
  it('still works with a session saved by an earlier version', async () => {
    const seen: string[] = [];
    const client = new Client(SERVER, null, async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(`${new URL(String(input)).pathname} ${headers.get('cookie')} ${headers.get('authorization')}`);
      return json({ nodes: [], nextOffset: null, ok: true });
    });
    client.session = 'old';
    await client.children(null);
    await client.logout();
    expect(seen).toEqual([
      '/api/nodes note_session=old null',
      '/api/auth/logout note_session=old null',
    ]);
  });
  it('explains a token without the permission', async () => {
    const client = new Client(SERVER, 's', async () => json({ error: 'x', code: 'TOKEN_SCOPE' }, 403));
    await expect(client.trash('a', 1)).rejects.toThrow('--read-only');
  });
  it('does not repeat a write', async () => {
    let calls = 0;
    const client = new Client(
      SERVER,
      's',
      async () => {
        calls++;
        return json({ error: '忙' }, 503);
      },
      0,
    );
    await expect(client.trash('a', 1)).rejects.toThrow('忙');
    expect(calls).toBe(1);
  });
});
describe('resolveTarget', () => {
  const tree = new Client(SERVER, 's', async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/api/nodes/'))
      return url.pathname.endsWith('/id1') ? json({ id: 'id1' }) : json({ error: '无' }, 404);
    return json({
      nodes:
        url.searchParams.get('parent') === 'w1'
          ? [{ id: 'p1', title: '项目' }]
          : [
              { id: 'w1', title: '工作' },
              { id: 'd1', title: '重名' },
              { id: 'd2', title: '重名' },
            ],
      nextOffset: null,
    });
  });
  it('accepts a link, an ID or a title path', async () => {
    await expect(resolveTarget(tree, `${SERVER}/n/abc`)).resolves.toBe('abc');
    await expect(resolveTarget(tree, 'id1')).resolves.toBe('id1');
    await expect(resolveTarget(tree, '工作/项目')).resolves.toBe('p1');
    await expect(resolveTarget(tree, '工作')).resolves.toBe('w1');
  });
  it('refuses another site, an unknown title and an ambiguous one', async () => {
    await expect(resolveTarget(tree, 'https://other.test/n/abc')).rejects.toThrow('不属于');
    await expect(resolveTarget(tree, '没有')).rejects.toThrow('找不到');
    await expect(resolveTarget(tree, '重名')).rejects.toThrow('d1、d2');
  });
});
describe('credentials', () => {
  it('are stored privately', async () => {
    const home = await mkdtemp(join(tmpdir(), 'xvi-config-'));
    const env = { XDG_CONFIG_HOME: home };
    await expect(loadCredentials(env)).resolves.toEqual({ tokens: {} });
    await saveCredentials({ default: SERVER, tokens: { [SERVER]: 'abc' } }, env);
    await expect(loadCredentials(env)).resolves.toMatchObject({ tokens: { [SERVER]: 'abc' } });
    const { mode } = await stat(join(home, 'xvi-note', 'credentials.json'));
    expect(mode & 0o777).toBe(0o600);
    await rm(home, { recursive: true });
  });
});
