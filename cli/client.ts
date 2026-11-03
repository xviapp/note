import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preparePassword, type PasswordParameters } from '../shared/password.ts';
import type { KeyRecord } from '../shared/encryption.ts';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types.ts';

const SESSION_COOKIE = 'note_session';
const RETRIED = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;

export class ApiError extends Error {
  status: number;
  code?: string;
  details: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export interface Credentials {
  default?: string;
  tokens: Record<string, string>;
  // Browser-style sessions saved by earlier versions; `xvi login` replaces them.
  sessions?: Record<string, string>;
}
// The token lives outside the workspace, so it is not among the files an agent is given.
const credentialsPath = (env: NodeJS.ProcessEnv) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'xvi-note', 'credentials.json');
export async function loadCredentials(env = process.env): Promise<Credentials> {
  try {
    const saved = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Partial<Credentials>;
    return { default: saved.default, tokens: saved.tokens ?? {}, sessions: saved.sessions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tokens: {} };
    throw new Error('无法读取登录信息，请删除 credentials.json 后重新登录。', { cause: error });
  }
}
export async function saveCredentials(credentials: Credentials, env = process.env): Promise<void> {
  const file = credentialsPath(env),
    temporary = `${file}.${randomUUID()}`;
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
export function serverOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(`站点地址不正确：${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('只能通过 HTTPS 连接站点（本机地址除外）。');
  return url.origin;
}
export interface SaveNote {
  content?: string;
  bodyBlobId?: string;
  metadata?: Record<string, string | null>;
  attachments: string[];
  revision: number;
  copies?: Record<string, string>;
}
export interface CreateNode extends Omit<SaveNote, 'revision' | 'attachments'> {
  id: string;
  kind: 'folder' | 'markdown' | 'text';
  title: string;
  parentId: string | null;
  attachments?: string[];
}
export class Client {
  server: string;
  token: string | null;
  fetcher: typeof fetch;
  retryMs: number;
  // A session saved by an earlier version, used until the next login.
  session: string | null = null;
  constructor(server: string, token: string | null, fetcher: typeof fetch = fetch, retryMs = 500) {
    this.server = server;
    this.token = token;
    this.fetcher = fetcher;
    this.retryMs = retryMs;
  }
  // The Worker accepts writes only from its own origin, which a CLI states itself.
  private send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('origin', this.server);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    else if (this.session) headers.set('cookie', `${SESSION_COOKIE}=${this.session}`);
    return this.fetcher(`${this.server}${path}`, { ...init, headers, redirect: 'error' });
  }
  private async failure(response: Response): Promise<ApiError> {
    const data = (await response.json().catch(() => null)) as
      | ({ error?: string; code?: string } & Record<string, unknown>)
      | null;
    if (response.status === 401 && data?.code !== 'INVALID_PASSWORD')
      return new ApiError(401, '登录已失效，请运行 xvi login。', data?.code ?? 'UNAUTHENTICATED');
    if (data?.code === 'TOKEN_SCOPE')
      return new ApiError(403, '当前令牌没有这个权限。需要写回时，请不带 --read-only 重新运行 xvi login。', data.code);
    return new ApiError(response.status, data?.error ?? `请求失败（${response.status}）。`, data?.code, data ?? {});
  }
  private async get(path: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | null = null,
        cause: unknown;
      try {
        response = await this.send(path);
      } catch (error) {
        cause = error;
      }
      if (response?.ok) return response;
      if (response && !RETRIED.has(response.status)) throw await this.failure(response);
      if (attempt === ATTEMPTS) {
        if (response) throw await this.failure(response);
        throw new Error(`无法连接 ${this.server}。`, { cause });
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryMs * attempt));
    }
  }
  private async getJson<T>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T;
  }
  // Writes are not repeated here: the next push repeats them under the same key.
  private async write<T>(
    path: string,
    method: string,
    data: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.send(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID(), ...headers },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw await this.failure(response);
    return (await response.json()) as T;
  }
  // Exchanges the password for a token, leaving no browser-style session behind.
  async login(password: string, name: string, scope: 'read' | 'write'): Promise<void> {
    const status = await this.getJson<{ initialized: boolean; password?: PasswordParameters }>(
      '/api/auth/status',
    );
    if (!status.initialized) throw new Error('站点尚未设置密码，请先在网页上完成初始化。');
    const response = await this.send('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: await preparePassword(password, status.password) }),
    });
    if (!response.ok) throw await this.failure(response);
    const prefix = `${SESSION_COOKIE}=`;
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(prefix));
    if (!cookie) throw new Error('站点没有返回登录会话。');
    const session = { cookie: cookie.split(';')[0] };
    const created = await this.send('/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...session },
      body: JSON.stringify({ name, scope }),
    });
    await this.send('/api/auth/logout', { method: 'POST', headers: session }).catch(() => {});
    if (created.status === 404) throw new Error('站点版本过旧，请先部署新版本。');
    if (!created.ok) throw await this.failure(created);
    this.token = ((await created.json()) as { token: string }).token;
  }
  async logout(): Promise<void> {
    const response = this.token
      ? await this.send('/api/tokens/current', { method: 'DELETE' })
      : await this.send('/api/auth/logout', { method: 'POST' });
    if (!response.ok && response.status !== 401) throw await this.failure(response);
    this.token = null;
    this.session = null;
  }
  node(id: string): Promise<NoteDetail> {
    return this.getJson(`/api/nodes/${encodeURIComponent(id)}`);
  }
  async children(parent: string | null): Promise<NoteNode[]> {
    const nodes: NoteNode[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const query = new URLSearchParams({ offset: String(offset) });
      if (parent) query.set('parent', parent);
      const page: { nodes: NoteNode[]; nextOffset: number | null } = await this.getJson(
        `/api/nodes?${query}`,
      );
      nodes.push(...page.nodes);
      offset = page.nextOffset;
    }
    return nodes;
  }
  // A stored file's bytes, sealed if that is how it is kept.
  async file(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(`/api/files/${encodeURIComponent(id)}`)).arrayBuffer());
  }
  async encryptionKeys(): Promise<KeyRecord[]> {
    return (await this.getJson<{ keys: KeyRecord[] }>('/api/encryption/keys')).keys;
  }
  async upload(name: string, bytes: Uint8Array, sealed?: { keyId: string; mime: string }): Promise<FileInfo> {
    const query = new URLSearchParams({ name, size: String(bytes.byteLength) });
    if (sealed) {
      query.set('key', sealed.keyId);
      query.set('mime', sealed.mime);
    }
    const response = await this.send(`/api/files?${query}`, { method: 'POST', body: bytes as BodyInit });
    if (!response.ok) throw await this.failure(response);
    return (await response.json()) as FileInfo;
  }
  async save(id: string, note: SaveNote, key: string): Promise<NoteNode> {
    const { token } = await this.write<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: id });
    return this.write(`/api/nodes/${encodeURIComponent(id)}/content`, 'PUT', note, {
      'x-note-edit': token,
      'x-idempotency-key': key,
    });
  }
  create(node: CreateNode, key: string): Promise<NoteNode> {
    return this.write('/api/nodes', 'POST', node, { 'x-idempotency-key': key });
  }
  update(
    id: string,
    change: { revision: number; title?: string; parentId?: string | null },
  ): Promise<NoteNode> {
    return this.write(`/api/nodes/${encodeURIComponent(id)}`, 'PATCH', change);
  }
  async subtreeCount(id: string): Promise<number> {
    return (await this.getJson<{ count: number }>(`/api/nodes/${encodeURIComponent(id)}/delete-preview`)).count;
  }
  trash(id: string, count: number): Promise<unknown> {
    return this.write(`/api/nodes/${encodeURIComponent(id)}`, 'DELETE', { count });
  }
}
