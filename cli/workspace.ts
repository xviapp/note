import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { NodeKind } from '../shared/types.ts';

export const META_DIR = '.xvi';
export const FILES_DIR = `${META_DIR}/files`;
const STATE_FILE = `${META_DIR}/state.json`;
const TEMP_DIR = `${META_DIR}/tmp`;
const ASSET_NAME = /^[a-zA-Z0-9_-]{1,80}\.[a-zA-Z0-9]{1,10}$/;
// What stands at a path that is not a regular file; it never equals a hash.
export const NOT_A_FILE = 'not-a-file';

export interface Entry {
  kind: NodeKind;
  title: string;
  path: string;
  revision: number;
  // SHA-256 of the file as last written; folders and omitted PDFs have none.
  hash?: string;
  // Names in .xvi/files this note links to.
  assets?: string[];
  omitted?: boolean;
}
export interface State {
  version: 1;
  server: string;
  // The pulled node, or null for the whole library.
  root: string | null;
  pdf: boolean;
  entries: Record<string, Entry>;
  // Generated guidance files with their hashes, so edits to them are kept.
  guides: Record<string, string>;
}
export const hashBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
function checkRelative(path: string): void {
  const parts = path.split('/');
  if (isAbsolute(path) || parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error(`工作区记录中的路径不正确：${path}`);
}
export class Workspace {
  root: string;
  constructor(root: string) {
    this.root = root;
  }
  private absolute(path: string): string {
    checkRelative(path);
    return join(this.root, path);
  }
  // Links placed in the workspace (by an agent, say) must not redirect a write outside it.
  async ensureDir(path: string): Promise<void> {
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      const absolute = this.absolute(current);
      try {
        await mkdir(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!(await lstat(absolute)).isDirectory())
        throw new Error(`${current} 不是目录，无法写入其中的内容。`);
    }
  }
  private async parentsAreDirectories(path: string): Promise<boolean> {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const stat = await lstat(this.absolute(parts.slice(0, i).join('/')));
      if (!stat.isDirectory()) return false;
    }
    return true;
  }
  // The file's hash, null when nothing is there, NOT_A_FILE for anything else.
  async hash(path: string): Promise<string | null> {
    try {
      if (!(await this.parentsAreDirectories(path))) return NOT_A_FILE;
      const absolute = this.absolute(path);
      if (!(await lstat(absolute)).isFile()) return NOT_A_FILE;
      return hashBytes(await readFile(absolute));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async exists(path: string): Promise<boolean> {
    return (await this.hash(path)) !== null;
  }
  // Written beside the target and renamed over it: never a half-written file,
  // and a link at the target is replaced, not followed.
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir(TEMP_DIR);
    const parent = dirname(path);
    if (parent !== '.') await this.ensureDir(parent);
    const temporary = `${TEMP_DIR}/${randomUUID()}`;
    await writeFile(this.absolute(temporary), bytes);
    try {
      await rename(this.absolute(temporary), this.absolute(path));
    } catch (error) {
      await rm(this.absolute(temporary), { force: true });
      throw error;
    }
  }
  async remove(path: string): Promise<void> {
    if (await this.parentsAreDirectories(path)) await rm(this.absolute(path), { force: true });
  }
  // Removes the directory only if empty, and whatever it leaves empty above it.
  async pruneDir(path: string): Promise<void> {
    for (let current = path; current !== '.'; current = dirname(current)) {
      try {
        if (!(await this.parentsAreDirectories(current))) return;
        await rmdir(this.absolute(current));
      } catch {
        return;
      }
    }
  }
  async files(path: string): Promise<string[]> {
    try {
      return await readdir(this.absolute(path));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async clearTemporary(): Promise<void> {
    await rm(this.absolute(TEMP_DIR), { recursive: true, force: true });
  }
  async loadState(): Promise<State | null> {
    let raw: string;
    try {
      raw = await readFile(this.absolute(STATE_FILE), 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    let state: State;
    try {
      state = JSON.parse(raw) as State;
    } catch {
      throw new Error(`${STATE_FILE} 已损坏，请换一个空目录重新拉取。`);
    }
    if (state?.version !== 1 || typeof state.entries !== 'object' || !state.entries)
      throw new Error(`${STATE_FILE} 的格式不受支持。`);
    // The agent can edit this file too, and its paths decide what gets removed.
    for (const entry of Object.values(state.entries)) {
      checkRelative(entry.path);
      if (entry.path.split('/')[0] === META_DIR) throw new Error(`工作区记录中的路径不正确：${entry.path}`);
      for (const asset of entry.assets ?? [])
        if (!ASSET_NAME.test(asset)) throw new Error(`工作区记录中的附件不正确：${asset}`);
    }
    for (const guide of Object.keys(state.guides ?? {})) checkRelative(guide);
    return { ...state, guides: state.guides ?? {} };
  }
  async saveState(state: State): Promise<void> {
    await this.write(STATE_FILE, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }
  // A workspace starts empty, so a mistyped path cannot scatter notes into a project.
  async isEmpty(): Promise<boolean> {
    try {
      return (await readdir(this.root)).every((name) => name === '.git');
    } catch (error) {
      if (missing(error)) return true;
      throw error;
    }
  }
}
