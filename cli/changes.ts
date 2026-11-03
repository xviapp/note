import { dirname, posix } from 'node:path';
import { normalHash } from './content.ts';
import { hashBytes, type Entry, type State, type Workspace } from './workspace.ts';

const decoder = new TextDecoder();
const TEXT_FILE = /\.(md|txt)$/;
const GUIDES = new Set(['AGENTS.md', 'CLAUDE.md']);
const isText = (kind: Entry['kind']) => kind === 'markdown' || kind === 'text';
export const stemOf = (path: string) => posix.basename(path).replace(/\.[^.]+$/, '');
// Where a node's children sit: a folder itself, 标题/ beside 标题.md.
const childDir = (entry: Pick<Entry, 'kind' | 'path'>) =>
  entry.kind === 'folder' ? entry.path : entry.path.replace(/\.[^./]+$/, '');
export interface Move {
  id: string;
  from: string;
  to: string;
}
export interface Changes {
  edits: string[];
  moves: Move[];
  creates: string[];
  // Roots of what was removed here, with how many nodes each takes along.
  deletes: { id: string; count: number }[];
  // Edited files of kinds that cannot be written back.
  readOnly: string[];
  // New files of kinds that are not created from here.
  ignored: string[];
  conflicts: string[];
  blocked: { path: string; reason: string }[];
  // Which node holds a directory, after the moves.
  owners: Map<string, string>;
}
function descendantsOf(entries: Record<string, Entry>) {
  const children = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(entries))
    if (entry.parent) children.set(entry.parent, [...(children.get(entry.parent) ?? []), id]);
  const below = (id: string): string[] =>
    (children.get(id) ?? []).flatMap((child) => [child, ...below(child)]);
  return below;
}
// What differs between the workspace and the last sync, without asking the server.
export async function findChanges(workspace: Workspace, state: State): Promise<Changes> {
  const result: Changes = {
    edits: [],
    moves: [],
    creates: [],
    deletes: [],
    readOnly: [],
    ignored: [],
    conflicts: [],
    blocked: [],
    owners: new Map(),
  };
  const entries = Object.entries(state.entries);
  const companions = new Set(entries.flatMap(([, entry]) => entry.remote?.path ?? []));
  const tracked = new Set(entries.map(([, entry]) => entry.path));
  const untracked = (await workspace.scan()).filter(
    (path) => !tracked.has(path) && !companions.has(path) && !GUIDES.has(path),
  );
  const missing = new Map<string, Entry>();
  for (const [id, entry] of entries) {
    if (entry.omitted) continue;
    if (entry.kind === 'folder') {
      if (!(await workspace.isDirectory(entry.path))) missing.set(id, entry);
      continue;
    }
    const local = await workspace.hash(entry.path);
    if (local === null) missing.set(id, entry);
    else if (entry.remote) result.conflicts.push(entry.path);
    else if (local !== entry.hash) {
      if (isText(entry.kind)) result.edits.push(entry.path);
      else result.readOnly.push(entry.path);
    }
  }
  // A missing file that reappears elsewhere with the same content has moved.
  const fingerprint = async (path: string) => {
    const bytes = await workspace.read(path);
    return TEXT_FILE.test(path)
      ? normalHash(decoder.decode(bytes))
      : hashBytes(bytes);
  };
  const candidates = new Map<string, string[]>();
  for (const path of untracked) {
    const print = await fingerprint(path);
    candidates.set(print, [...(candidates.get(print) ?? []), path]);
  }
  const lost = new Map<string, string[]>();
  for (const [id, entry] of missing) {
    if (entry.kind === 'folder') continue;
    const print = entry.normal ?? entry.hash!;
    lost.set(print, [...(lost.get(print) ?? []), id]);
  }
  const moved = new Map<string, string>();
  const taken = new Set<string>();
  for (const [print, ids] of lost) {
    const paths = candidates.get(print);
    // Identical copies leave no way to tell which went where.
    if (ids.length === 1 && paths?.length === 1) {
      moved.set(ids[0], paths[0]);
      taken.add(paths[0]);
    }
  }
  // A folder whose files all reappear under one new directory was renamed, and
  // its contents go with it (including copies the step above could not tell apart).
  const folders = [...missing]
    .filter(([, entry]) => entry.kind === 'folder')
    .sort(([, a], [, b]) => a.path.length - b.path.length);
  const present = new Set(
    entries.filter(([id, entry]) => entry.kind === 'folder' && !missing.has(id)).map(([, e]) => e.path),
  );
  const renamed: [string, string][] = [];
  const mapped = (path: string) => {
    for (const [from, to] of renamed)
      if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
    return null;
  };
  for (const [id, folder] of folders) {
    const inherited = mapped(folder.path);
    if (inherited) {
      if (await workspace.isDirectory(inherited)) {
        moved.set(id, inherited);
      }
      continue;
    }
    const targets = new Set<string>();
    for (const [other, to] of moved) {
      const entry = state.entries[other];
      if (dirname(entry.path) === folder.path) targets.add(dirname(to));
    }
    const [target] = targets;
    if (targets.size === 1 && target !== '.' && !present.has(target)) {
      renamed.push([folder.path, target]);
      moved.set(id, target);
    }
  }
  for (const [id, entry] of missing) {
    if (moved.has(id) || entry.kind === 'folder') continue;
    const to = mapped(entry.path);
    if (to && untracked.includes(to) && !taken.has(to)) {
      moved.set(id, to);
      taken.add(to);
    }
  }
  const pathNow = (id: string, entry: Entry) => moved.get(id) ?? entry.path;
  for (const [id, entry] of entries)
    if (!missing.has(id) || moved.has(id))
      result.owners.set(childDir({ kind: entry.kind, path: pathNow(id, entry) }), id);
  const below = descendantsOf(state.entries);
  for (const [id, to] of moved) {
    const entry = state.entries[id];
    if (id === state.root) result.blocked.push({ path: entry.path, reason: '同步的根条目不能改名或移动' });
    else if (entry.variant === 'book-page')
      result.blocked.push({ path: entry.path, reason: '书页不能从书中移出或改名' });
    else result.moves.push({ id, from: entry.path, to });
  }
  const removed = new Set([...missing.keys()].filter((id) => !moved.has(id)));
  // An unlisted file below a removed folder goes with it.
  for (const [id, entry] of entries)
    if (entry.omitted && entry.parent && removed.has(entry.parent)) removed.add(id);
  for (const id of removed) {
    const entry = state.entries[id];
    const stay = below(id).filter((other) => !removed.has(other) && !moved.has(other));
    if (id === state.root) {
      result.blocked.push({ path: entry.path, reason: '同步的根条目不能从这里删除' });
    } else if (stay.length) {
      result.blocked.push({ path: entry.path, reason: '已删除，但它的下级仍在本地' });
    } else if (!entry.parent || !removed.has(entry.parent)) {
      const taking = below(id).filter((other) => removed.has(other));
      result.deletes.push({ id, count: taking.length + 1 });
    }
  }
  for (const path of untracked) {
    if (taken.has(path)) continue;
    if (TEXT_FILE.test(path)) result.creates.push(path);
    else result.ignored.push(path);
  }
  return result;
}
