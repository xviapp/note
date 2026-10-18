/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import { blobReferences, referencingNodes } from '../worker/blob-references';
import { UNREFERENCED } from '../worker/storage';
import { backupColumns } from '../shared/backup';

// Every column that points at `blobs` must keep its blob from cleanup, travel
// in backups and pin the blob when the row is written. The schema is the
// source of truth, so a new reference fails here until all of that is done.
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
// References that are not library content: kept from cleanup, not backed up.
const OPERATIONAL = new Set(['backup_files.blob_id']);

type Reference = { table: string; column: string };
let references: Reference[] = [];
let triggers: { tbl_name: string; sql: string }[] = [];

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  const tables = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'",
  ).all<{ name: string }>();
  for (const { name } of tables.results) {
    const keys = await bindings.DB.prepare('SELECT "table", "from" FROM pragma_foreign_key_list(?)')
      .bind(name)
      .all<{ table: string; from: string }>();
    for (const key of keys.results) if (key.table === 'blobs') references.push({ table: name, column: key.from });
  }
  references = references.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
  triggers = (
    await bindings.DB.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type='trigger'").all<{
      tbl_name: string;
      sql: string;
    }>()
  ).results;
});

// `FROM table alias WHERE alias.column=...` pairs in a reference expression.
function referenced(sql: string): Set<string> {
  const found = new Set<string>();
  for (const match of sql.matchAll(/FROM (\w+) (\w+) WHERE ([^)]*)\)/g)) {
    const [, table, alias, where] = match;
    for (const column of where.matchAll(new RegExp(`\\b${alias}\\.(\\w+)=`, 'g'))) found.add(`${table}.${column[1]}`);
  }
  return found;
}

describe('blob reference contract', () => {
  it('finds the blob references in the schema', () => {
    expect(references.length).toBeGreaterThan(10);
  });

  it('keeps every referenced blob from cleanup', () => {
    const library = referenced(blobReferences('blobs.id'));
    const all = referenced(UNREFERENCED);
    for (const { table, column } of references) {
      const name = `${table}.${column}`;
      expect(all, `${name} missing from UNREFERENCED`).toContain(name);
      if (!OPERATIONAL.has(name)) expect(library, `${name} missing from blobReferences`).toContain(name);
    }
  });

  it('knows which note holds every library blob reference', () => {
    const notes = new Set(
      [...referencingNodes('(?)').join('\n').matchAll(/FROM (\w+) (\w+) WHERE \2\.(\w+) IN/g)].map(
        ([, table, , column]) => `${table}.${column}`,
      ),
    );
    for (const { table, column } of references) {
      const name = `${table}.${column}`;
      if (OPERATIONAL.has(name) || table === 'clips') continue;
      expect(notes, `${name} missing from referencingNodes`).toContain(name);
    }
  });

  it('backs up every library blob reference', () => {
    const columns = backupColumns as Record<string, readonly string[]>;
    for (const { table, column } of references) {
      if (OPERATIONAL.has(`${table}.${column}`)) continue;
      expect(columns[table] ?? [], `${table}.${column} missing from backupColumns`).toContain(column);
    }
  });

  it('guards and pins every library blob reference', () => {
    for (const { table, column } of references) {
      if (OPERATIONAL.has(`${table}.${column}`)) continue;
      const own = triggers.filter((t) => t.tbl_name === table && t.sql.includes(column));
      const guard = own.some((t) => /\bBEFORE\s+INSERT\b/i.test(t.sql) && t.sql.includes("'ready'"));
      const pin = own.some((t) => /\bAFTER\s+(INSERT|UPDATE)\b/i.test(t.sql) && t.sql.includes('draft_until'));
      expect(guard, `${table}.${column} needs a BEFORE INSERT guard that the blob is ready`).toBe(true);
      expect(pin, `${table}.${column} needs an AFTER trigger clearing draft_until`).toBe(true);
    }
  });
});
