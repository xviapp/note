import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preparePassword, type PasswordParameters } from '../shared/password.ts';
import type { NoteDetail, NoteNode } from '../shared/types.ts';

const SESSION_COOKIE = 'note_session';
const RETRIED = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export interface Credentials {
  default?: string;
  sessions: Record<string, string>;
}
// The session lives outside the workspace: an agent working there must not read it.
const credentialsPath = (env: NodeJS.ProcessEnv) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'xvi-note', 'credentials.json');
export async function loadCredentials(env = process.env): Promise<Credentials> {
  try {
    const saved = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Partial<Credentials>;
    return { default: saved.default, sessions: saved.sessions ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} };
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
export class Client {
  server: string;
  session: string | null;
  fetcher: typeof fetch;
  retryMs: number;
  constructor(server: string, session: string | null, fetcher: typeof fetch = fetch, retryMs = 500) {
    this.server = server;
    this.session = session;
    this.fetcher = fetcher;
    this.retryMs = retryMs;
  }
  // The Worker accepts writes only from its own origin, which a CLI states itself.
  private send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('origin', this.server);
    if (this.session) headers.set('cookie', `${SESSION_COOKIE}=${this.session}`);
    return this.fetcher(`${this.server}${path}`, { ...init, headers, redirect: 'error' });
  }
  private async failure(response: Response): Promise<ApiError> {
    const data = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (response.status === 401 && data?.code !== 'INVALID_PASSWORD')
      return new ApiError(401, '登录已失效，请运行 xvi login。', data?.code ?? 'UNAUTHENTICATED');
    return new ApiError(response.status, data?.error ?? `请求失败（${response.status}）。`, data?.code);
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
  async login(password: string): Promise<void> {
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
    const session = cookie?.slice(prefix.length).split(';')[0];
    if (!session) throw new Error('站点没有返回登录会话。');
    this.session = session;
  }
  async logout(): Promise<void> {
    const response = await this.send('/api/auth/logout', { method: 'POST' });
    if (!response.ok && response.status !== 401) throw await this.failure(response);
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
  // A file's bytes, or null when the server only holds it sealed.
  async file(id: string): Promise<Uint8Array | null> {
    const response = await this.get(`/api/files/${encodeURIComponent(id)}`);
    if (response.headers.has('x-note-key')) {
      await response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
