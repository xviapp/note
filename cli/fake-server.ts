// A small in-memory stand-in for the Worker's note API, for the CLI's tests.
export interface FakeFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  key_id?: string | null;
}
export interface FakeNode {
  id: string;
  parent: string | null;
  kind: 'folder' | 'markdown' | 'text' | 'pdf' | 'image' | 'link';
  title: string;
  revision?: number;
  content?: string;
  key_id?: string | null;
  variant?: string;
  url?: string;
  file?: FakeFile;
  attachments?: FakeFile[];
  sealed?: string;
  trashed?: boolean;
}
export class FakeServer {
  nodes: FakeNode[] = [];
  files = new Map<string, Uint8Array>();
  uploads: { name: string; bytes: Uint8Array; key: string | null; mime: string | null }[] = [];
  calls: string[] = [];
  // Requests already answered, by idempotency key.
  operations = new Map<string, string>();
  listFails = false;
  failing = new Set<string>();
  // Answer the next save or create with this error, after doing the work if `lost`.
  loseNextResponse = false;
  sharedFiles: { id: string; name: string; mime: string }[] = [];
  keys: Record<string, unknown>[] = [];
  summary(node: FakeNode) {
    return {
      ...node,
      parent_id: node.parent,
      file_blob_id: node.file?.id ?? null,
      revision: node.revision ?? 1,
      key_id: node.key_id ?? null,
      url: node.url ?? null,
      variant: node.variant ?? node.kind,
      child_count: this.nodes.filter((item) => item.parent === node.id && !item.trashed).length,
    };
  }
  get(id: string): FakeNode {
    return this.nodes.find((node) => node.id === id)!;
  }
  find(title: string): FakeNode {
    return this.nodes.find((node) => node.title === title && !node.trashed)!;
  }
  private subtree(id: string): FakeNode[] {
    const found = [this.get(id)];
    for (const node of found)
      found.push(...this.nodes.filter((item) => item.parent === node.id && !item.trashed));
    return found;
  }
  private attach(node: FakeNode, content: string, ids: string[]) {
    const all = new Set([
      ...ids,
      ...[...content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]{1,80})/g)].map((match) => match[1]),
    ]);
    node.attachments = [...all].flatMap((id) => {
      const bytes = this.files.get(id);
      const upload = this.uploads.find((item) => item.name === id);
      return bytes
        ? [{ id, name: upload?.name ?? `${id}.png`, mime: upload?.mime ?? 'image/png', size: bytes.length }]
        : [];
    });
  }
  private applyBody(node: FakeNode, data: Record<string, unknown>) {
    if (typeof data.bodyBlobId === 'string') {
      const bytes = this.files.get(data.bodyBlobId)!;
      node.sealed = Buffer.from(bytes).toString('base64url');
      node.content = '';
    } else {
      node.sealed = undefined;
      node.content = String(data.content ?? '');
    }
    this.attach(node, node.content, (data.attachments as string[]) ?? []);
  }
  private reply(data: unknown, status = 200): Response {
    if (status < 400 && this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('连接中断');
    }
    return Response.json(data, { status });
  }
  fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname,
      method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.calls.push(`${method === 'GET' ? '' : `${method} `}${path}${url.search}`);
    const data = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const key = headers.get('x-idempotency-key');
    if (path === '/api/encryption/keys') return Response.json({ keys: this.keys });
    if (path === '/api/nodes' && method === 'GET') {
      if (this.listFails) return Response.json({ error: '故障' }, { status: 500 });
      const parent = url.searchParams.get('parent');
      return Response.json({
        nodes: this.nodes
          .filter((node) => node.parent === parent && !node.trashed)
          .map((node) => this.summary(node)),
        nextOffset: null,
      });
    }
    if (path === '/api/nodes' && method === 'POST') {
      const prior = key && this.operations.get(key);
      if (prior) return this.reply(this.summary(this.get(prior)), 201);
      const body = data();
      if (this.sharedFiles.length && !body.copies)
        return Response.json({ error: '共用', code: 'FILES_SHARED', files: this.sharedFiles }, { status: 409 });
      const parent = (body.parentId as string | null) ?? null;
      const node: FakeNode = {
        id: String(body.id),
        parent,
        kind: body.kind as FakeNode['kind'],
        title: String(body.title),
        revision: 1,
        key_id: parent ? (this.get(parent).key_id ?? null) : null,
      };
      this.applyBody(node, body);
      this.nodes.push(node);
      if (key) this.operations.set(key, node.id);
      return this.reply(this.summary(node), 201);
    }
    if (path === '/api/edit/unlock') return Response.json({ token: `edit:${String(data().nodeId)}` });
    if (path === '/api/files' && method === 'POST') {
      const id = `up${this.uploads.length + 1}`;
      const bytes = new Uint8Array(init!.body as Uint8Array);
      this.files.set(id, bytes);
      this.uploads.push({
        name: url.searchParams.get('name')!,
        bytes,
        key: url.searchParams.get('key'),
        mime: url.searchParams.get('mime'),
      });
      return Response.json(
        {
          id,
          name: url.searchParams.get('name'),
          mime: url.searchParams.get('mime') ?? 'image/png',
          size: bytes.length,
        },
        { status: 201 },
      );
    }
    const preview = path.match(/^\/api\/nodes\/(.+)\/delete-preview$/)?.[1];
    if (preview) return Response.json({ count: this.subtree(preview).length, title: '' });
    const content = path.match(/^\/api\/nodes\/(.+)\/content$/)?.[1];
    if (content) {
      const node = this.get(content),
        body = data();
      if (headers.get('x-note-edit') !== `edit:${content}`)
        return Response.json({ error: '未解锁', code: 'EDIT_LOCKED' }, { status: 403 });
      const prior = key && this.operations.get(key);
      if (prior) return this.reply(this.summary(node));
      if (this.sharedFiles.length && !body.copies)
        return Response.json({ error: '共用', code: 'FILES_SHARED', files: this.sharedFiles }, { status: 409 });
      if (body.revision !== (node.revision ?? 1))
        return Response.json({ error: '冲突', code: 'VERSION_CONFLICT' }, { status: 409 });
      this.applyBody(node, body);
      node.revision = (node.revision ?? 1) + 1;
      if (key) this.operations.set(key, node.id);
      return this.reply(this.summary(node));
    }
    const nodeId = path.match(/^\/api\/nodes\/([^/]+)$/)?.[1];
    if (nodeId) {
      const found = this.get(nodeId);
      if (!found || found.trashed || this.failing.has(nodeId))
        return Response.json({ error: '不存在' }, { status: found && !found.trashed ? 500 : 404 });
      if (method === 'PATCH') {
        const body = data();
        if (body.revision !== (found.revision ?? 1))
          return Response.json({ error: '冲突', code: 'VERSION_CONFLICT' }, { status: 409 });
        if (body.title !== undefined) found.title = String(body.title);
        if (body.parentId !== undefined) found.parent = body.parentId as string | null;
        found.revision = (found.revision ?? 1) + 1;
        return this.reply(this.summary(found));
      }
      if (method === 'DELETE') {
        for (const node of this.subtree(nodeId)) node.trashed = true;
        return this.reply({ id: 'batch' });
      }
      return Response.json({
        ...this.summary(found),
        content: found.content ?? '',
        sealed: found.sealed,
        file: found.file,
        attachments: found.attachments ?? [],
        breadcrumbs: [],
      });
    }
    const file = path.match(/^\/api\/files\/(.+)$/)?.[1];
    const bytes = file && this.files.get(file);
    if (!bytes) return Response.json({ error: '不存在' }, { status: 404 });
    return new Response(bytes.slice());
  };
}
