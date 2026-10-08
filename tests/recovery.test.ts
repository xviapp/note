/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { cleanup } from '../worker/recovery';
import type { Env } from '../worker/types';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const DAY = 86400_000;
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('DELETE FROM idempotency'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare('UPDATE site SET allocated_bytes=0 WHERE id=1'),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length) await bindings.FILES.delete(objects.objects.map((o) => o.key));
});
async function seedFiles(count: number) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await bindings.DB.batch(ids.map((id) => bindings.DB.prepare(
    "INSERT INTO blobs(id,object_key,name,mime,size,state,draft_until,created_at) VALUES(?,?,?,'text/plain',1,'ready',0,0)",
  ).bind(id, id, id)));
  await Promise.all(ids.map((id) => bindings.FILES.put(id, 'x')));
  return ids;
}
async function scheduled(time: string) {
  const context = createExecutionContext();
  await worker.scheduled(createScheduledController({
    scheduledTime: Date.parse(time), cron: '*/30 * * * *',
  }), bindings, context);
  await waitOnExecutionContext(context);
}
async function allocated() {
  return bindings.DB.prepare('SELECT allocated_bytes FROM site WHERE id=1').first<number>('allocated_bytes');
}

it('keeps half-hour maintenance, scans files every six hours and expires deduplication daily', async () => {
  await seedFiles(1);
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO login_attempts VALUES('expired',1,0)"),
    bindings.DB.prepare("INSERT INTO idempotency(key,operation,created_at) VALUES('old','create',?)").bind(Date.now() - 8 * DAY),
    bindings.DB.prepare("INSERT INTO idempotency(key,operation,created_at) VALUES('recent','create',?)").bind(Date.now() - 6 * DAY),
  ]);
  // These historical scheduled times also exercise delayed delivery, independent of Date.now().
  await scheduled('2026-10-01T00:30:00Z');
  expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM login_attempts').first('n')).toBe(0);
  expect(await allocated()).toBe(1);
  expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM idempotency').first('n')).toBe(2);
  await scheduled('2026-10-01T06:00:00Z');
  expect(await allocated()).toBe(0);
  expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM idempotency').first('n')).toBe(2);
  await seedFiles(1);
  await scheduled('2026-10-02T00:00:00Z');
  expect(await allocated()).toBe(0);
  expect((await bindings.DB.prepare('SELECT key FROM idempotency').all()).results).toEqual([{ key: 'recent' }]);
  const plan = await bindings.DB.prepare('EXPLAIN QUERY PLAN DELETE FROM idempotency WHERE created_at<?').bind(0).all<{ detail: string }>();
  expect(plan.results.some((row) => row.detail.includes('idempotency_created'))).toBe(true);
});

it('bounds a manual sweep, drains multiple batches and leaves excess work for the next sweep', async () => {
  await seedFiles(205);
  expect(await cleanup(bindings)).toEqual({ removed: 200 });
  expect(await allocated()).toBe(5);
  expect((await bindings.FILES.list()).objects).toHaveLength(5);
  expect(await cleanup(bindings)).toEqual({ removed: 5 });
  expect(await allocated()).toBe(0);
});

it('continues after a failed R2 batch and retries it later without releasing its quota early', async () => {
  await seedFiles(25);
  const remove = vi.fn(async (keys: string | string[]) => bindings.FILES.delete(keys));
  remove.mockRejectedValueOnce(new Error('injected delete failure'));
  const broken = { ...bindings, FILES: { delete: remove } as unknown as R2Bucket };
  expect(await cleanup(broken)).toEqual({ removed: 5 });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(await allocated()).toBe(20);
  expect(await bindings.DB.prepare("SELECT COUNT(*) n FROM blobs WHERE state='deleting'").first('n')).toBe(20);
  expect(await cleanup(bindings)).toEqual({ removed: 20 });
  expect(await allocated()).toBe(0);
});

it('preserves unexpired drafts and only frees quota after D1 deletion succeeds', async () => {
  const [draft, garbage] = await seedFiles(2);
  await bindings.DB.prepare('UPDATE blobs SET draft_until=? WHERE id=?').bind(Date.now() + DAY, draft).run();
  await bindings.DB.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON blobs BEGIN SELECT RAISE(ABORT, 'injected D1 failure'); END");
  try {
    expect(await cleanup(bindings)).toEqual({ removed: 0 });
    expect(await allocated()).toBe(2);
    expect(await bindings.FILES.head(garbage!)).toBeNull();
    expect(await bindings.FILES.head(draft!)).not.toBeNull();
  } finally {
    await bindings.DB.exec('DROP TRIGGER fail_cleanup');
  }
  expect(await cleanup(bindings)).toEqual({ removed: 1 });
  expect(await allocated()).toBe(1);
});
