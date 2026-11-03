import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NoteNode } from '../shared/types.ts';
import type { Client } from './client.ts';
import { Contents } from './content.ts';
import type { Keyring } from './keys.ts';
import type { OnProgress } from './progress.ts';
import { listTree } from './pull.ts';
import { META_DIR, type State, type Workspace } from './workspace.ts';

// What changed on the server since the last sync. Locked nodes are compared by
// their details only, so this asks for no password.
export async function remoteChanges(
  client: Client,
  state: State,
  onProgress?: OnProgress,
): Promise<string[]> {
  const roots: NoteNode[] = state.root ? [await client.node(state.root)] : await client.children(null);
  const items = await listTree(client, roots, (node) => state.decrypt || !node.key_id, undefined, onProgress);
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const { node, path } of items) {
    seen.add(node.id);
    const entry = state.entries[node.id];
    if (!entry || entry.revision !== node.revision) changed.push(path);
  }
  for (const [id, entry] of Object.entries(state.entries))
    if (!seen.has(id)) changed.push(entry.path);
  return changed.sort();
}
function gitDiff(from: string, to: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', from, to],
      // Outside the workspace, whose repository settings should have no say here.
      { cwd: tmpdir(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        // Exit status 1 only means that the files differ.
        resolve(!error || (error as { code?: unknown }).code === 1 ? stdout : null);
      },
    );
  });
}
// The differences between the server's copy of a note and the local file, or null without git.
export async function noteDiff(
  client: Client,
  workspace: Workspace,
  state: State,
  keyring: Keyring | null,
  id: string,
): Promise<string | null> {
  const path = state.entries[id].path;
  const remote = await new Contents(client, workspace, state, keyring).load(await client.node(id), path);
  if (!remote) return `${path}：已加密，无法比较。\n`;
  const name = `${META_DIR}/tmp/${randomUUID()}`;
  await workspace.write(name, remote.bytes);
  const before = join(workspace.root, name),
    after = join(workspace.root, path);
  try {
    const diff = await gitDiff(before, after);
    return diff === null
      ? null
      : diff.replaceAll(before.slice(1), `远端/${path}`).replaceAll(after.slice(1), `本地/${path}`);
  } finally {
    await rm(before, { force: true });
  }
}
