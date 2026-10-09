import { describe, expect, it } from 'vitest';
import { blobReferences, blobUnreferenced } from '../worker/blob-references';
import { readLimited } from '../worker/http';

describe('stream and blob reference helpers', () => {
  it('reads a stream once and enforces its byte limit', async () => {
    const bytes = await readLimited(new Response('hello').body, 5);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    await expect(readLimited(new Response('hello!').body, 5)).rejects.toMatchObject({ status: 413 });
  });

  it('keeps every library blob reference under one SQL expression', () => {
    const references = blobReferences('b.id');
    expect(references).toContain('v.body_blob_id=b.id');
    expect(references).toContain('k.cover_blob_id=b.id');
    expect(references).toContain('c.blob_id=b.id');
    expect(blobUnreferenced('blobs.id')).toContain('NOT (EXISTS');
  });
});
