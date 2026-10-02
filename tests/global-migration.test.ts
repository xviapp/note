/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, applyD1Migrations } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Env } from '../worker/types';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
it('preserves existing chat rows, attachments, locks and trash across the global-scope migration', async () => {
  const migrations = bindings.TEST_MIGRATIONS;
  await applyD1Migrations(bindings.DB, migrations.slice(0, -1));
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO nodes(id,kind,title,position,revision,created_at,updated_at) VALUES('old-note','text','旧笔记',0,1,1,1)",
    ),
    bindings.DB.prepare(
      "INSERT INTO blobs(id,object_key,name,mime,size,state,created_at) VALUES('old-body','old-body','body','text/plain',3,'ready',1),('old-file','old-file','file','image/png',5,'ready',1)",
    ),
    bindings.DB.prepare(
      "INSERT INTO assistant_threads(node_id,active_request,locked_until) VALUES('old-note','pending-request',123456)",
    ),
    bindings.DB.prepare(
      "INSERT INTO assistant_messages(sequence,id,node_id,request_id,role,status,body_blob_id,image_blob_id,exported_node_id,error,created_at) VALUES(42,'old-message','old-note','pending-request','assistant','interrupted','old-body','old-file','old-note','中断',2)",
    ),
    bindings.DB.prepare(
      "INSERT INTO assistant_message_files(message_id,blob_id) VALUES('old-message','old-file')",
    ),
    bindings.DB.prepare(
      "INSERT INTO trash_batches(id,root_id,title,expected_count,deleted_at,expires_at) VALUES('old-trash','old-note','旧笔记',1,1,2)",
    ),
    bindings.DB.prepare("UPDATE nodes SET trash_id='old-trash' WHERE id='old-note'"),
  ]);
  const before = await bindings.DB.prepare('SELECT * FROM assistant_messages').all();
  await applyD1Migrations(bindings.DB, migrations);
  expect((await bindings.DB.prepare('SELECT * FROM assistant_messages').all()).results).toEqual(
    before.results,
  );
  expect(
    await bindings.DB.prepare("SELECT * FROM assistant_threads WHERE node_id='old-note'").first(),
  ).toMatchObject({ active_request: 'pending-request', locked_until: 123456 });
  expect(
    (await bindings.DB.prepare('SELECT * FROM assistant_message_files').all()).results,
  ).toHaveLength(1);
  await bindings.DB.prepare("INSERT INTO assistant_threads(node_id) VALUES('qingli-global')").run();
  await bindings.DB.prepare("DELETE FROM nodes WHERE id='old-note'").run();
  expect(
    (await bindings.DB.prepare('SELECT * FROM assistant_messages').all()).results,
  ).toHaveLength(0);
  expect(
    (await bindings.DB.prepare('SELECT * FROM assistant_message_files').all()).results,
  ).toHaveLength(0);
  expect(
    (await bindings.DB.prepare('SELECT node_id FROM assistant_threads').all()).results,
  ).toEqual([{ node_id: 'qingli-global' }]);
});
