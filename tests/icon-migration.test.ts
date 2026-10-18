/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, applyD1Migrations } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Env } from '../worker/types';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
it('moves folder icons into the columns any entry can use', async () => {
  const migrations = bindings.TEST_MIGRATIONS;
  await applyD1Migrations(bindings.DB, migrations.filter((migration) => migration.name < '0029'));
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO blobs(id,object_key,name,mime,size,state,created_at) VALUES('icon','icon','icon.png','image/png',5,'ready',1)",
    ),
    bindings.DB.prepare(
      "INSERT INTO nodes(id,kind,title,position,revision,created_at,updated_at,icon_emoji) VALUES('emoji','folder','表情',0,1,1,1,'📚')",
    ),
    bindings.DB.prepare(
      "INSERT INTO nodes(id,kind,title,position,revision,created_at,updated_at,icon_blob_id) VALUES('picture','folder','图片',1,1,1,1,'icon')",
    ),
  ]);
  await applyD1Migrations(bindings.DB, migrations);
  const rows = await bindings.DB.prepare(
    'SELECT id,icon_emoji,icon_blob_id,icon_glyph,icon_file_id FROM nodes ORDER BY position',
  ).all();
  expect(rows.results).toEqual([
    { id: 'emoji', icon_emoji: null, icon_blob_id: null, icon_glyph: '📚', icon_file_id: null },
    { id: 'picture', icon_emoji: null, icon_blob_id: null, icon_glyph: null, icon_file_id: 'icon' },
  ]);
  // A note can now have one.
  await bindings.DB.prepare(
    "INSERT INTO nodes(id,kind,title,position,revision,created_at,updated_at,icon_glyph) VALUES('note','markdown','笔记',2,1,1,1,'📝')",
  ).run();
});
