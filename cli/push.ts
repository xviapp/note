import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { sealBytes, sealText } from '../shared/encryption.ts';
import { markdownMetadata } from '../shared/projects.ts';
import type { NoteNode } from '../shared/types.ts';
import { rewriteLinks } from '../src/import-links.ts';
import { stemOf, type Changes, type Move } from './changes.ts';
import { ApiError, type Client, type SaveNote } from './client.ts';
import { Contents, normalHash, type Loaded } from './content.ts';
import type { Keyring } from './keys.ts';
import { fileIdsIn, normalizeLinks, relocateLinks, replaceFileIds } from './links.ts';
import type { OnProgress } from './progress.ts';
import { remotePath } from './pull.ts';
import { FILES_DIR, hashBytes, type Entry, type State, type Workspace } from './workspace.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const UPLOADABLE: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};
export interface PushReport {
  saved: string[];
  created: string[];
  moved: string[];
  trashed: string[];
  conflicts: string[];
  warnings: string[];
  failed: { path: string; message: string }[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);
const toNodeFields = (node: NoteNode) => ({
  title: node.title,
  revision: node.revision,
  parent: node.parent_id,
  key_id: node.key_id ?? null,
  variant: node.variant,
  file: node.file_blob_id,
});
// Marks a conflict as merged: the server's copy becomes the base of the local file.
export async function resolveConflict(workspace: Workspace, state: State, path: string): Promise<void> {
  const entry = Object.values(state.entries).find((item) => item.path === path);
  if (!entry?.remote) throw new Error(`${path} 没有未解决的冲突。`);
  await workspace.remove(entry.remote.path);
  Object.assign(entry, {
    revision: entry.remote.revision,
    hash: entry.remote.hash,
    normal: entry.remote.normal,
  });
  delete entry.remote;
  await workspace.saveState(state);
}
export class Pusher {
  client: Client;
  workspace: Workspace;
  state: State;
  changes: Changes;
  keyring: Keyring | null;
  contents: Contents;
  report: PushReport = {
    saved: [],
    created: [],
    moved: [],
    trashed: [],
    conflicts: [],
    warnings: [],
    failed: [],
  };
  onProgress: OnProgress;
  constructor(
    client: Client,
    workspace: Workspace,
    state: State,
    changes: Changes,
    keyring: Keyring | null,
    onProgress: OnProgress = () => {},
  ) {
    this.onProgress = onProgress;
    this.client = client;
    this.workspace = workspace;
    this.state = state;
    this.changes = changes;
    this.keyring = keyring;
    this.contents = new Contents(client, workspace, state, keyring);
  }
  private entry(id: string): Entry {
    return this.state.entries[id];
  }
  // State is saved after every step: what reached the server stays known if the next step fails.
  private async attempt(path: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      this.report.failed.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
    await this.workspace.saveState(this.state);
  }
  private async keyFor(keyId: string, label: string): Promise<CryptoKey> {
    const key = this.keyring ? await this.keyring.forKey(keyId, label) : null;
    if (!key) throw new Error('这个位置已加密，需要解锁才能写入。');
    return key;
  }
  private async pendingId(path: string): Promise<{ id: string; key: string }> {
    this.state.pending[path] ??= { id: randomUUID(), key: randomUUID() };
    // Saved first: a retry after a lost response must name the same operation.
    await this.workspace.saveState(this.state);
    return this.state.pending[path];
  }
  // The node owning a directory, creating folders for directories that are new.
  private async parentOf(dir: string): Promise<string | null> {
    if (dir === '.' || dir === '') {
      if (this.state.root) throw new Error('这里在同步的条目之外，请放到它的目录下。');
      return null;
    }
    const owner = this.changes.owners.get(dir);
    if (owner) return owner;
    const parent = await this.parentOf(posix.dirname(dir));
    const { id, key } = await this.pendingId(dir);
    const node = await this.client.create(
      { id, kind: 'folder', title: posix.basename(dir), parentId: parent },
      key,
    );
    this.state.entries[node.id] = { kind: 'folder', path: dir, ...toNodeFields(node) };
    delete this.state.pending[dir];
    this.changes.owners.set(dir, node.id);
    return node.id;
  }
  private scopeOf(parent: string | null): string | null {
    return parent ? (this.entry(parent)?.key_id ?? null) : null;
  }
  // A body sealed and uploaded alone; the request then names it.
  private async sealedBody(
    keyId: string,
    kind: string,
    content: string,
    label: string,
  ): Promise<Pick<SaveNote, 'bodyBlobId' | 'metadata'>> {
    const key = await this.keyFor(keyId, label);
    const sealed = await sealBytes(key, keyId, encoder.encode(content));
    const body = await this.client.upload('content.txt', sealed, {
      keyId,
      mime: 'text/plain; charset=utf-8',
    });
    const metadata = kind === 'markdown' ? markdownMetadata(content) : null;
    const seal = async (text: string | null | undefined) =>
      text ? sealText(key, keyId, text) : (text ?? null);
    return {
      bodyBlobId: body.id,
      ...(metadata
        ? {
            metadata: {
              title: await seal(metadata.title),
              status: await seal(metadata.status),
              excerpt: await seal(metadata.summary),
            },
          }
        : {}),
    };
  }
  private async uploadFile(path: string, keyId: string | null, label: string): Promise<string> {
    const bytes = await this.workspace.read(path);
    const suffix = posix.extname(path).toLowerCase();
    const name = posix.basename(path);
    if (!keyId) return (await this.client.upload(name, bytes)).id;
    const sealed = await sealBytes(await this.keyFor(keyId, label), keyId, bytes);
    return (await this.client.upload(name, sealed, { keyId, mime: UPLOADABLE[suffix] })).id;
  }
  // Relative links as the server keeps them: other notes by ID, new images and
  // PDFs uploaded. Links that lead nowhere are left alone and reported.
  private async resolveLinks(text: string, path: string, keyId: string | null): Promise<string> {
    const normal = normalizeLinks(text);
    const dir = posix.dirname(path);
    const located = (target: string) => {
      const full = posix.normalize(posix.join(dir, target));
      return full.startsWith('../') || full.startsWith('.') || full.startsWith('/') ? null : full;
    };
    const byPath = new Map(Object.entries(this.state.entries).map(([id, entry]) => [entry.path, id]));
    const uploads = new Map<string, string>();
    const wanted: string[] = [];
    // A first pass over the links only finds what has to be uploaded.
    rewriteLinks(normal, (target) => {
      const full = located(target);
      if (full && !byPath.has(full)) wanted.push(full);
      return null;
    });
    for (const full of new Set(wanted)) {
      const suffix = posix.extname(full).toLowerCase();
      if (!UPLOADABLE[suffix]) continue;
      // The server cannot clean an SVG it only sees sealed, and this tool does not either.
      if (keyId && suffix === '.svg') continue;
      if ((await this.workspace.hash(full)) === null) continue;
      uploads.set(full, await this.uploadFile(full, keyId, stemOf(path)));
    }
    const rewritten = rewriteLinks(normal, (target) => {
      const full = located(target);
      if (!full) return null;
      const id = byPath.get(full);
      if (id) {
        const entry = this.entry(id);
        const file = entry.file ? `/api/files/${entry.file}` : undefined;
        return { link: `/n/${id}`, ...(file ? { image: file } : {}) };
      }
      const upload = uploads.get(full);
      if (!upload) return null;
      return { link: `/api/files/${upload}`, image: `/api/files/${upload}` };
    });
    for (const target of new Set(rewritten.missing))
      this.report.warnings.push(`${path}：找不到链接目标 ${target}，已原样保留。`);
    return rewritten.content;
  }
  // Another note's files are copied for this one, sealed like its own (see ownFiles in worker/library.ts).
  private async copyFiles(error: ApiError, keyId: string | null, label: string): Promise<Record<string, string>> {
    const files = error.details.files as { id: string; name: string; mime: string }[] | undefined;
    if (!files?.length) throw error;
    const copies: Record<string, string> = {};
    for (const file of files) {
      const bytes = await this.contents.fileBytes(file.id, label);
      if (!bytes) throw new Error(`无法读取附件 ${file.name}。`);
      if (keyId) {
        const sealed = await sealBytes(await this.keyFor(keyId, label), keyId, bytes);
        copies[file.id] = (await this.client.upload(file.name, sealed, { keyId, mime: file.mime })).id;
      } else copies[file.id] = (await this.client.upload(file.name, bytes)).id;
    }
    return copies;
  }
  private async withCopies<T>(
    content: string,
    attachments: string[],
    keyId: string | null,
    label: string,
    send: (content: string, attachments: string[], copies?: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(content, attachments);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'FILES_SHARED') throw error;
      const copies = await this.copyFiles(error, keyId, label);
      return send(
        replaceFileIds(content, copies),
        attachments.map((id) => copies[id] ?? id),
        copies,
      );
    }
  }
  // The file as a pull would write it, so nothing reads as edited afterwards.
  // `sent` is the text this push read and sent: a file changed since then, or a
  // retry that found an older copy on the server, stays as a local edit.
  private async settle(
    id: string,
    path: string,
    node: NoteNode,
    loaded: Loaded,
    sent?: { file: Uint8Array; body: string },
  ): Promise<void> {
    const hash = hashBytes(loaded.bytes);
    const current =
      !sent ||
      ((await this.workspace.hash(path)) === hashBytes(sent.file) &&
        normalHash(sent.body) === loaded.normal);
    if (current) await this.workspace.write(path, loaded.bytes);
    this.state.entries[id] = {
      kind: node.kind,
      path,
      ...toNodeFields(node),
      hash,
      normal: loaded.normal,
      ...(loaded.assets?.length ? { assets: loaded.assets } : {}),
    };
  }
  private async saveConflict(entry: Entry, node: NoteNode, loaded: Loaded): Promise<void> {
    const path = remotePath(entry.path);
    await this.workspace.write(path, loaded.bytes);
    entry.remote = {
      path,
      revision: node.revision,
      hash: hashBytes(loaded.bytes),
      normal: loaded.normal,
    };
    entry.assets = [...new Set([...(entry.assets ?? []), ...(loaded.assets ?? [])])].sort();
    this.report.conflicts.push(entry.path);
  }
  private async pushEdit(id: string): Promise<void> {
    const entry = this.entry(id),
      path = entry.path;
    const file = await this.workspace.read(path);
    const text = decoder.decode(file);
    const detail = await this.client.node(id);
    const remote = await this.contents.load(detail, path);
    if (!remote) throw new Error('这篇笔记已加密，需要解锁才能写入。');
    // Already on the server, as when the response to an earlier push was lost.
    if (normalHash(text) === remote.normal) return this.settle(id, path, detail, remote);
    if (detail.revision !== entry.revision && remote.normal !== entry.normal)
      return this.saveConflict(entry, detail, remote);
    const keyId = detail.key_id ?? null;
    const content = await this.resolveLinks(text, path, keyId);
    const label = stemOf(path);
    const known = detail.attachments.map((item) => item.id);
    let saved: NoteNode;
    let sentBody = content;
    try {
      saved = await this.withCopies(
        content,
        [...new Set([...known, ...fileIdsIn(content)])],
        keyId,
        label,
        async (body, attachments, copies) => {
          sentBody = body;
          return this.client.save(
            id,
            {
              ...(keyId ? await this.sealedBody(keyId, 'markdown', body, label) : { content: body }),
              attachments,
              revision: detail.revision,
              ...(copies ? { copies } : {}),
            },
            // The same edit of the same version repeats safely after a lost response.
            digest(`save:${id}:${detail.revision}:${normalHash(body)}`),
          );
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        const fresh = await this.client.node(id);
        const loaded = await this.contents.load(fresh, path);
        if (loaded) return this.saveConflict(entry, fresh, loaded);
      }
      throw error;
    }
    const loaded = await this.contents.load(saved, path);
    if (!loaded) throw new Error('已写回，但无法读取结果，请重新拉取。');
    await this.settle(id, path, saved, loaded, { file, body: sentBody });
    this.report.saved.push(path);
  }
  private async pushCreate(path: string): Promise<void> {
    const file = await this.workspace.read(path);
    const text = decoder.decode(file);
    const parent = await this.parentOf(posix.dirname(path));
    const { id, key } = await this.pendingId(path);
    const kind = path.endsWith('.txt') ? 'text' : 'markdown';
    const keyId = this.scopeOf(parent);
    const label = stemOf(path);
    const content = await this.resolveLinks(text, path, keyId);
    let sentBody = content;
    const node = await this.withCopies(
      content,
      fileIdsIn(content),
      keyId,
      label,
      async (body, attachments, copies) => {
        sentBody = body;
        return this.client.create(
          {
            id,
            kind,
            title: label,
            parentId: parent,
            ...(keyId ? await this.sealedBody(keyId, kind, body, label) : { content: body }),
            attachments,
            ...(copies ? { copies } : {}),
          },
          key,
        );
      },
    );
    delete this.state.pending[path];
    const loaded = await this.contents.load(node, path);
    if (!loaded) throw new Error('已新建，但无法读取结果，请重新拉取。');
    await this.settle(node.id, path, node, loaded, { file, body: sentBody });
    this.changes.owners.set(path.replace(/\.[^./]+$/, ''), node.id);
    this.report.created.push(path);
  }
  private async pushMove({ id, from, to }: Move): Promise<void> {
    const entry = this.entry(id);
    const parent = await this.parentOf(posix.dirname(to));
    // A folder's whole name is its title; a dot in it is no suffix.
    const nameOf = entry.kind === 'folder' ? (path: string) => posix.basename(path) : stemOf;
    const title = nameOf(from) === nameOf(to) ? entry.title : nameOf(to);
    const moving = parent !== (entry.parent ?? null);
    if (moving && this.scopeOf(parent) !== (entry.key_id ?? null))
      throw new Error('不能跨越加密范围移动，请到页面上操作。');
    let node: Pick<Entry, 'title' | 'revision' | 'parent' | 'key_id' | 'variant' | 'file'> = entry;
    if (moving || title !== entry.title) {
      try {
        node = toNodeFields(
          await this.client.update(id, {
            revision: entry.revision,
            ...(title !== entry.title ? { title } : {}),
            ...(moving ? { parentId: parent } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
          this.report.conflicts.push(from);
          return;
        }
        throw error;
      }
      this.report.moved.push(`${from} → ${to}`);
    }
    Object.assign(entry, node, { path: to });
    if (entry.kind === 'markdown' || entry.kind === 'text') {
      // Its links to .xvi/files depend on how deep it now sits.
      const text = new TextDecoder().decode(await this.workspace.read(to));
      const bytes = encoder.encode(relocateLinks(text, entry.assets, to));
      if (hashBytes(bytes) !== entry.hash) {
        await this.workspace.write(to, bytes);
        entry.hash = hashBytes(bytes);
      }
    }
  }
  private async pushDelete({ id, count }: { id: string; count: number }): Promise<void> {
    const entry = this.entry(id);
    const remote = await this.client.subtreeCount(id);
    // More below it than this workspace knows: encrypted, or added since.
    if (remote !== count)
      throw new Error(`远端有 ${remote} 个条目，这里只同步了 ${count} 个，请到页面上删除。`);
    const subtree = [id];
    for (const current of subtree)
      for (const [other, item] of Object.entries(this.state.entries))
        if (item.parent === current) subtree.push(other);
    for (const member of subtree) {
      const node = await this.client.node(member);
      if (node.revision !== this.entry(member).revision) {
        this.report.conflicts.push(this.entry(member).path);
        return;
      }
    }
    await this.client.trash(id, remote);
    for (const member of subtree) delete this.state.entries[member];
    this.report.trashed.push(entry.path);
  }
  async run(options: { deletes: boolean }): Promise<PushReport> {
    const { changes } = this;
    // Parents first: a child's place is worked out from its parent's new one.
    const moves = [...changes.moves].sort((a, b) => a.to.length - b.to.length);
    const creates = [...changes.creates].sort((a, b) => a.length - b.length);
    const deletes = options.deletes ? changes.deletes : [];
    const written = moves.filter((move) => !move.carried);
    const total = written.length + changes.edits.length + creates.length + deletes.length;
    let done = 0;
    const step = (path: string, work: () => Promise<void>) => {
      this.onProgress(`写回 ${++done}/${total}：${path}`);
      return this.attempt(path, work);
    };
    for (const move of moves)
      if (move.carried) await this.attempt(move.from, () => this.pushMove(move));
      else await step(move.from, () => this.pushMove(move));
    for (const path of changes.edits) {
      const id = Object.keys(this.state.entries).find((key) => this.entry(key).path === path)!;
      await step(path, () => this.pushEdit(id));
    }
    for (const path of creates) await step(path, () => this.pushCreate(path));
    for (const item of deletes) await step(this.entry(item.id).path, () => this.pushDelete(item));
    await this.removeUnusedAssets();
    return this.report;
  }
  private async removeUnusedAssets(): Promise<void> {
    if (this.report.failed.length) return;
    const used = new Set(Object.values(this.state.entries).flatMap((entry) => entry.assets ?? []));
    for (const name of await this.workspace.files(FILES_DIR))
      if (!used.has(name)) await this.workspace.remove(`${FILES_DIR}/${name}`);
  }
}
