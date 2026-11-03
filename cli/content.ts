import { fromBase64Url, sealedKeyId } from '../shared/encryption.ts';
import type { NoteDetail, NoteNode } from '../shared/types.ts';
import type { Client } from './client.ts';
import type { Keyring } from './keys.ts';
import { localizeLinks, normalizeLinks } from './links.ts';
import { fileSuffix } from './names.ts';
import { FILES_DIR, hashBytes, type State, type Workspace } from './workspace.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export interface Loaded {
  bytes: Uint8Array;
  assets?: string[];
  // Comparable however deep the note sits (see normalHash).
  normal: string;
}
export const normalHash = (text: string): string => hashBytes(encoder.encode(normalizeLinks(text)));
const urlFile = (url: string | null) =>
  `[InternetShortcut]\nURL=${(url ?? '').replace(/[\r\n]/g, '')}\n`;
// Turns what the server holds into what the workspace shows, decrypting when allowed.
export class Contents {
  client: Client;
  workspace: Workspace;
  state: State;
  keyring: Keyring | null;
  constructor(client: Client, workspace: Workspace, state: State, keyring: Keyring | null) {
    this.client = client;
    this.workspace = workspace;
    this.state = state;
    this.keyring = keyring;
  }
  // A stored file's plain bytes; null when it stays sealed.
  async fileBytes(id: string, label: string): Promise<Uint8Array | null> {
    const bytes = await this.client.file(id);
    if (this.keyring) return this.keyring.open(bytes, label);
    return sealedKeyId(bytes) ? null : bytes;
  }
  private async saveAttachments(detail: NoteDetail): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const file of detail.attachments) {
      if (file.key_id && !this.keyring) continue;
      if (file.mime === 'application/pdf' && !this.state.pdf) continue;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(file.id)) continue;
      const name = `${file.id}${fileSuffix(file.name, file.mime)}`;
      if (!(await this.workspace.exists(`${FILES_DIR}/${name}`))) {
        const bytes = await this.fileBytes(file.id, detail.title);
        if (!bytes) continue;
        await this.workspace.write(`${FILES_DIR}/${name}`, bytes);
      }
      names.set(file.id, name);
    }
    return names;
  }
  private async text(detail: NoteDetail): Promise<string | null> {
    if (!detail.sealed) return !this.keyring && detail.key_id ? null : detail.content;
    if (!this.keyring) return null;
    const bytes = await this.keyring.open(fromBase64Url(detail.sealed), detail.title);
    return bytes && decoder.decode(bytes);
  }
  // What a node's file should hold at this path; null when only its sealed form is readable.
  async load(node: NoteNode, path: string): Promise<Loaded | null> {
    if (node.kind === 'link') {
      const bytes = encoder.encode(urlFile(node.url));
      return { bytes, normal: hashBytes(bytes) };
    }
    const detail = await this.client.node(node.id);
    if (node.kind === 'pdf' || node.kind === 'image') {
      if (!detail.file) throw new Error('这个条目没有文件。');
      if (detail.file.key_id && !this.keyring) return null;
      const stored = await this.fileBytes(detail.file.id, detail.title);
      if (!stored) return null;
      // A sealed file's stored size counts its seal, so only a plain one can be compared.
      if (!detail.file.key_id && stored.byteLength !== detail.file.size)
        throw new Error('下载的文件不完整。');
      return { bytes: stored, normal: hashBytes(stored) };
    }
    const text = await this.text(detail);
    if (text === null) return null;
    const names = await this.saveAttachments(detail);
    const local = localizeLinks(text, names, path);
    return {
      bytes: encoder.encode(local),
      assets: [...names.values()].sort(),
      normal: normalHash(local),
    };
  }
}
