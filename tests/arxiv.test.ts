/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';
import type { NoteDetail, StorageInfo } from '../shared/types';
import { cleanup } from '../worker/recovery';
import { paperHtml, paperPng } from './fixtures/arxiv';
import { diagramSvg, hostileSvg } from './fixtures/svg';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
let contexts: ExecutionContext[] = [];
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  options: { anonymous?: boolean; origin?: string; key?: string } = {},
) {
  const execution = createExecutionContext();
  contexts.push(execution);
  return worker.fetch(
    new Request(`https://notes.test${path}`, {
      method,
      headers: {
        origin: options.origin || 'https://notes.test',
        'content-type': 'application/json',
        ...(!options.anonymous ? { cookie } : {}),
        'x-idempotency-key': options.key || crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
    execution,
  );
}
async function ok<T = any>(path: string, method = 'GET', body?: unknown, options = {}): Promise<T> {
  const response = await request(path, method, body, options);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
function provider(html = paperHtml) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    String(input).endsWith('.png')
      ? new Response(
          Uint8Array.from(atob(paperPng), (c) => c.charCodeAt(0)),
          { headers: { 'content-type': 'image/png' } },
        )
      : new Response(html, { headers: { 'content-type': 'text/html' } }),
  );
}
beforeEach(async () => {
  contexts = [];
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM nodes'),
    bindings.DB.prepare('DELETE FROM trash_batches'),
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('DELETE FROM idempotency'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,allocated_bytes=0,quota_bytes=8000000000 WHERE id=1',
    ),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map((o) => o.key));
  const response = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Note2026',
  });
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
  vi.restoreAllMocks();
});

describe('arXiv paper import', () => {
  it('requires a private same-origin request and rejects non-paper URLs before fetching', async () => {
    const fetch = provider();
    expect(
      (
        await request(
          '/api/import/arxiv',
          'POST',
          { url: 'https://arxiv.org/html/2503.01800v1' },
          { anonymous: true },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/import/arxiv',
          'POST',
          { url: 'https://arxiv.org/html/2503.01800v1' },
          { origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    for (const url of [
      'https://localhost/html/2503.01800v1',
      'https://arxiv.org.evil.test/html/2503.01800v1',
      'https://arxiv.org:444/html/2503.01800v1',
      'https://user@arxiv.org/html/2503.01800v1',
      'https://arxiv.org/help',
      'file:///etc/passwd',
      'https://arxiv.org/html/2503.01800v0',
    ])
      expect((await request('/api/import/arxiv', 'POST', { url })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('imports article HTML, MathML and private images once, preserving source, license and lifecycle', async () => {
    const fetch = provider();
    const parent = await ok('/api/nodes', 'POST', { kind: 'folder', title: 'Papers' });
    const input = { url: 'https://arxiv.org/abs/2503.01800', parentId: parent.id };
    const imported = await ok('/api/import/arxiv', 'POST', input, { key: 'import-once' });
    expect(imported).toMatchObject({
      kind: 'link',
      arxiv_id: '2503.01800v1',
      title: 'A paper & its equations',
      url: 'https://arxiv.org/html/2503.01800v1',
      parent_id: parent.id,
    });
    expect(String(fetch.mock.calls[0][0])).toBe('https://arxiv.org/html/2503.01800');
    const detail = await ok<NoteDetail>(`/api/nodes/${imported.id}`);
    expect(detail.content).toContain('alttext="E=mc^2"');
    expect(detail.content).toContain('href="#S2.E1"');
    expect(detail.content).toContain('CC BY 4.0');
    for (const removed of [
      'Website navigation',
      'Website footer',
      '<script',
      '<style',
      'Duplicate website contents',
    ])
      expect(detail.content).not.toContain(removed);
    expect(detail.attachments).toHaveLength(1);
    const image = detail.attachments[0];
    expect(detail.content).toContain(`/api/files/${image.id}`);
    expect(
      (await request(`/api/files/${image.id}`, 'GET', undefined, { anonymous: true })).status,
    ).toBe(401);
    expect((await request(`/api/files/${image.id}`)).headers.get('content-type')).toBe('image/png');
    expect((await ok('/api/import/arxiv', 'POST', input, { key: 'import-once' })).id).toBe(
      imported.id,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await request('/api/edit/unlock', 'POST', { nodeId: imported.id })).status).toBe(400);
    expect(
      (
        await request(`/api/nodes/${imported.id}`, 'PATCH', {
          revision: imported.revision,
          url: 'https://arxiv.org/html/2503.01800v2',
        })
      ).status,
    ).toBe(400);
    const child = await ok('/api/nodes', 'POST', {
      kind: 'markdown',
      parentId: imported.id,
      title: '阅读笔记',
      content: '# 结论',
    });
    expect(child.parent_id).toBe(imported.id);
    await cleanup(bindings);
    const storage = await ok<StorageInfo>('/api/storage');
    expect(storage.orphanBytes).toBe(0);
    expect(storage.currentBytes).toBe(storage.allocatedBytes);
    const trash = await ok(`/api/nodes/${imported.id}`, 'DELETE', { count: 2 });
    await cleanup(bindings);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect((await ok<NoteDetail>(`/api/nodes/${imported.id}`)).content).toBe(detail.content);
    const again = await ok(`/api/nodes/${imported.id}`, 'DELETE', { count: 2 });
    await ok(`/api/trash/${again.id}`, 'DELETE');
    await Promise.all(contexts.map(waitOnExecutionContext));
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(404);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });

  it('supports paper snapshots larger than the ordinary note limit', async () => {
    provider(paperHtml.replace('</article>', `<p>${'x'.repeat(1_100_000)}</p></article>`));
    const node = await ok('/api/import/arxiv', 'POST', {
      url: 'https://arxiv.org/html/2503.01800v1',
    });
    expect((await ok<NoteDetail>(`/api/nodes/${node.id}`)).content.length).toBeGreaterThan(
      1_100_000,
    );
  });

  it('imports sanitized SVG assets privately and retains vector styling and local references', async () => {
    const fetch = provider();
    fetch.mockImplementation(async (input) =>
      String(input).endsWith('.svg')
        ? new Response(hostileSvg, { headers: { 'content-type': 'image/svg+xml' } })
        : new Response(paperHtml.replaceAll('figure.png', 'figure.svg'), {
            headers: { 'content-type': 'text/html' },
          }),
    );
    const node = await ok('/api/import/arxiv', 'POST', {
      url: 'https://arxiv.org/html/2503.01800v1',
    });
    const detail = await ok<NoteDetail>(`/api/nodes/${node.id}`);
    const file = detail.attachments[0];
    expect(file).toMatchObject({ name: 'figure.svg', mime: 'image/svg+xml' });
    const response = await request(`/api/files/${file.id}`);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-disposition')).toMatch(/^inline/);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const svg = await response.text();
    expect(svg).toContain('fill:url(#blue)');
    expect(svg).toContain('href="#point"');
    expect(svg).not.toMatch(/svg-tracker|script|onload|DOCTYPE|foreignObject/);
    expect(file.size).toBe(new TextEncoder().encode(svg).length);
    expect(
      (await request(`/api/files/${file.id}`, 'GET', undefined, { anonymous: true })).status,
    ).toBe(401);
    expect(
      (await request(`/api/files/${file.id}?download=1`)).headers.get('content-disposition'),
    ).toMatch(/^attachment/);
    expect(fetch).toHaveBeenCalledTimes(2);
    const storage = await ok<StorageInfo>('/api/storage');
    expect(storage.orphanBytes).toBe(0);
    const trash = await ok(`/api/nodes/${node.id}`, 'DELETE', { count: 1 });
    await ok(`/api/trash/${trash.id}`, 'DELETE');
    await Promise.all(contexts.map(waitOnExecutionContext));
    await cleanup(bindings);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });

  it('extracts inline and nested SVG into a single image, retaining its own stylesheet', async () => {
    const inline = diagramSvg
      .slice(diagramSvg.indexOf('<svg'))
      .replace('</svg>', '<svg x="0" y="0"><circle r="1"/></svg></svg>');
    provider(paperHtml.replace('</article>', `<figure>${inline}</figure></article>`));
    const node = await ok('/api/import/arxiv', 'POST', {
      url: 'https://arxiv.org/html/2503.01800v1',
    });
    const detail = await ok<NoteDetail>(`/api/nodes/${node.id}`);
    expect(detail.attachments).toHaveLength(2);
    expect(detail.content).not.toMatch(/<svg|<style/);
    const file = detail.attachments.find((file) => file.mime === 'image/svg+xml')!;
    expect(detail.content).toContain(`/api/files/${file.id}`);
    const svg = await (await request(`/api/files/${file.id}`)).text();
    expect(svg).toContain('fill:url(#blue)');
    expect(svg.match(/<svg/g)).toHaveLength(2);
    expect(svg).not.toContain('body');
  });

  it('rolls back malformed SVG imports and sanitizes SVG uploads before they can be viewed', async () => {
    const fetch = provider(
      paperHtml.replace('</article>', '<img src="2503.01800v1/broken.svg"></article>'),
    );
    const normal = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) =>
      String(input).endsWith('.svg')
        ? new Response('<svg><g></svg>', { headers: { 'content-type': 'image/svg+xml' } })
        : normal(input, init),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(400);
    expect((await ok('/api/nodes')).nodes).toHaveLength(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
    const bytes = new TextEncoder().encode(hostileSvg);
    const execution = createExecutionContext();
    contexts.push(execution);
    const upload = await worker.fetch(
      new Request(`https://notes.test/api/files?name=plot.svg&size=${bytes.byteLength}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://notes.test', 'content-type': 'image/svg+xml' },
        body: bytes,
      }),
      bindings,
      execution,
    );
    expect(upload.status).toBe(201);
    const file = (await upload.json()) as { id: string; mime: string };
    expect(file.mime).toBe('image/svg+xml');
    expect(await (await request(`/api/files/${file.id}`)).text()).not.toContain('svg-tracker');
  });

  it('keeps every figure linked to its own stored image when the paper has more than ten images', async () => {
    const extra = Array.from(
      { length: 11 },
      (_, index) => `<img src="2503.01800v1/figure-${index}.png">`,
    ).join('');
    provider(paperHtml.replace('</article>', `${extra}</article>`));
    const node = await ok('/api/import/arxiv', 'POST', {
      url: 'https://arxiv.org/html/2503.01800v1',
    });
    const detail = await ok<NoteDetail>(`/api/nodes/${node.id}`);
    const sources = [...detail.content.matchAll(/<img[^>]*src="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(detail.attachments).toHaveLength(12);
    expect(new Set(sources)).toEqual(
      new Set(detail.attachments.map((file) => `/api/files/${file.id}`)),
    );
  });

  it('cleans up already imported images when a later image fails or the body exceeds quota', async () => {
    const fetch = provider(
      paperHtml.replace('</article>', '<img src="2503.01800v1/broken.png"></article>'),
    );
    fetch.mockImplementation(async (input) =>
      String(input).endsWith('broken.png')
        ? new Response('not a picture')
        : String(input).endsWith('.png')
          ? new Response(Uint8Array.from(atob(paperPng), (c) => c.charCodeAt(0)))
          : new Response(
              paperHtml.replace('</article>', '<img src="2503.01800v1/broken.png"></article>'),
              { headers: { 'content-type': 'text/html' } },
            ),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(400);
    expect((await ok('/api/nodes')).nodes).toHaveLength(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
    fetch.mockRestore();
    provider();
    await bindings.DB.prepare('UPDATE site SET quota_bytes=100 WHERE id=1').run();
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(413);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });

  it('rejects external redirects, outside images, missing articles and oversized responses', async () => {
    const fetch = provider();
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.test/track' } }),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(
      new Response(paperHtml.replace('2503.01800v1/figure.png', 'https://evil.test/track.png'), {
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(400);
    fetch.mockResolvedValueOnce(
      new Response('<html>No article</html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(400);
    fetch.mockResolvedValueOnce(
      new Response('huge', {
        headers: { 'content-type': 'text/html', 'content-length': String(9 * 1_048_576) },
      }),
    );
    expect(
      (await request('/api/import/arxiv', 'POST', { url: 'https://arxiv.org/html/2503.01800v1' }))
        .status,
    ).toBe(413);
    expect((await ok('/api/nodes')).nodes).toHaveLength(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
});
