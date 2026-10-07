# Migrations

Numbered SQL files, applied in order; `pnpm run deploy` applies production migrations before deploying.

- SQLite table rebuilds copy data into `migration_saved_*` tables first (see `0009_global_assistant.sql`); `tests/global-migration.test.ts` covers that pattern.
- A new table or column that references `blobs` needs, besides the `UNREFERENCED` clauses in `worker/storage.ts`: a guard trigger that the referenced blob is `ready`, an AFTER INSERT/UPDATE trigger that sets the blob's `draft_until` to NULL (otherwise purged rows leave their blob reserved for a day), and an entry in the backup format (`shared/backup.ts` columns and validation, `worker/backups.ts` restore). See `0010_paper_translations.sql`.
