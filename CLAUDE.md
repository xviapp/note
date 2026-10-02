# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Overview

页间 (xvi-note) is a single-user notes/reading app: one React UI served by a Cloudflare Worker (static assets + `/api/*`, same origin) and packaged into a Capacitor Android shell. User-facing strings, error messages, README and `docs/` are in Simplified Chinese; keep new UI text and error messages in Chinese. The AI assistant is called 青藜 (Qingli) and uses DeepSeek.

## Commands

- Single Worker test file: `npx vitest run tests/library.test.ts`; single test: add `-t '<name>'`.
- Single e2e spec/project: `npx playwright test e2e/notebook.spec.ts --project=desktop`. E2E serves the built `dist/` through `scripts/e2e-server.mjs` on port 8799, so run `npm run build` after UI changes before e2e.
- `npm run db:local` applies migrations to local D1 (`npm run dev` does this automatically).
- `npm run theme:check` / `theme:sync` compare/regenerate family theme tokens from a sibling `../packages/theme` checkout; the build itself uses the committed CSS.
- Android native: `node scripts/android.mjs testDebugUnitTest` and `node scripts/android.mjs lintDebug`.

## Architecture

**Request flow.** `worker/index.ts` is a single hand-written router (regex matches on `path` + `method`, no framework). Order matters: `enforceOrigin` → `publicAuth` (setup/login, unauthenticated) → `requireSession` (cookie) → `accountAuth` (password/logout) → feature routes. Handlers throw `AppError(status, message, code?)` from `worker/http.ts`; the router converts it to `{ error, code }` JSON. A cron (`*/30`) and `POST /api/cleanup` run `cleanup()` in `worker/recovery.ts`.

**Storage model.** D1 holds metadata only; all content (note bodies, files, chat messages, translations, arXiv HTML, folder icons, backups) lives in private R2 as immutable objects tracked by the `blobs` table (`worker/storage.ts`). Blobs are reserved as `pending` with a `draft_until`, then marked `ready`; nothing is deleted inline. Instead, garbage collection deletes blobs matching `UNREFERENCED` / `LIBRARY_UNREFERENCED` in `storage.ts`. **When adding any new table column that references `blobs`, add it to these clauses**, or cleanup will delete live data. Quota accounting counts history, trash, pending uploads and reservations.

**Notes and versions.** `nodes` form a tree where any kind (folder, markdown, text, file, paper, link) can have children. Saving creates a new version (current + last 5 kept) with a revision check for conflicts. Mutating endpoints take an `x-idempotency-key` header (`operationKey()` in `worker/library.ts`) stored in the `idempotency` table. Editing note content or restoring a version also requires a per-node edit token (`POST /api/edit/unlock` → `x-note-edit` header, checked by `requireEdit`). The client in `src/api.ts` keeps these tokens; this enforces the app's "read-only by default, confirm before editing" behavior.

**Shared contracts.** `shared/` is imported by both `src/` and `worker/`: API types (`shared/types.ts`), limits, SVG sanitizer, SSE parsing, token-budget/context estimation for the assistant (`shared/ai-context.ts`), and backup format. Change limits and types here, not in both sides separately.

**AI features.** `worker/deepseek.ts` stores the API key encrypted with a key derived from `APP_SECRET` and makes the provider calls. `worker/assistant.ts` handles per-node chat threads plus a global thread (`GLOBAL_ASSISTANT_ID = 'qingli-global'`), streamed to the client over SSE. Budgets are checked before any paid call, and paid requests are never retried automatically. `worker/translation.ts` caches results per (file, source text, target language). Tests mock DeepSeek; never hit the real API in tests.

**Frontend.** `src/App.tsx` is the shell (routing via `src/navigation.ts`, theme, sidebar); feature UIs are in `src/components/`. All API calls go through `api()` in `src/api.ts`. It falls back to the IndexedDB offline cache (`src/offline-cache.ts`) for whitelisted GET reads when offline. `scripts/offline-shell.ts` is a Vite plugin that generates `/sw.js` for the web build only (Android uses bundled assets, no service worker). See `docs/offline-reading.md` for cache invariants (what may be cached, and clearing on logout/session loss).

**Builds.** The web build goes to `dist/`. `vite build --mode android` goes to `dist-android/` and aliases PDF.js to its `legacy` build for older WebViews. The Android WebView uses origin `https://note.xvi.app` with local assets; only `/api/` goes to the network (details in `docs/android.md`).

**Testing.** Worker tests run inside workerd via `@cloudflare/vitest-pool-workers` (`vitest.config.ts`) with migrations applied from `TEST_MIGRATIONS`. They call the worker via `SELF.fetch` and reset tables in `beforeEach`. Files run serially (`fileParallelism: false`).

**Migrations.** These are numbered SQL files in `migrations/`. SQLite table rebuilds copy data into `migration_saved_*` tables first (see `0009_global_assistant.sql`); `tests/global-migration.test.ts` covers that pattern. `pnpm run deploy` applies production migrations before deploying.
