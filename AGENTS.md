# Repository Guidelines

## Overview

页间 (xvi-note) is a single-user notes and reading app: one React UI served by a Cloudflare Worker (static assets + `/api/*`, same origin) and packaged into a Capacitor Android shell. The AI assistant is called 青藜 (Qingli) and uses DeepSeek (`deepseek-flash`).

## Architecture

**Request flow.** `worker/index.ts` is a hand-written router (regex on path + method). Order matters: `enforceOrigin` → `publicAuth` (setup/login) → `requireSession` (cookie) → `accountAuth` → feature routes. Handlers throw `AppError(status, message, code?)` from `worker/http.ts`, returned as `{ error, code }` JSON. A cron (`*/30`) and `POST /api/cleanup` run `cleanup()` in `worker/recovery.ts`.

**Storage.** D1 holds metadata; all content (note bodies, files, chat messages, translations, arXiv HTML, icons, backups) lives in private R2 as immutable objects tracked by `blobs` (`worker/storage.ts`). Blobs are reserved `pending` with a `draft_until`, then marked `ready`; nothing is deleted inline. Cleanup deletes blobs not named in `blobReferences()` (`worker/blob-references.ts`), so any new column referencing `blobs` must be added there (see `migrations/AGENTS.md`); `tests/blob-contract.test.ts` checks every such column in the schema against cleanup, backups and triggers. Quota counts history, trash, pending uploads and reservations.

**Notes.** `nodes` form a tree in which any kind can have children. Saving creates a version (current + last 5) with a revision check. Mutating endpoints take `x-idempotency-key` (`operationKey()`, `idempotency` table). Editing a body or restoring a version needs a per-node edit token (`POST /api/edit/unlock` → `x-note-edit`, checked by `requireEdit`): notes are read-only until the user clicks 编辑正文 (or presses E), which requests the token.

**Books.** A book is a folder with a `books` row, created via `POST /api/nodes` with `book`. A page is a Markdown child with a `book_pages` row (photo + text recognized by DeepSeek, plus a summary and questions bound to the version they were written from). A discussion is a hidden Markdown child of a page (`book_discussions`; filtered out of listings and search by `NOT_DISCUSSION`) whose 青藜 thread is the conversation; `NotePane` binds `AssistantPanel` to it. `organizeDiscussion()` writes a section between `<!-- discussion:ID -->` markers into the page's reading note, tracking a hash in `book_note_sections` to refuse overwriting hand edits. All of this lives in `worker/books.ts`; `bookPrompt()` gives every chat inside a book the book's role and, below a page, the page's text and summary. E2E tests point `DEEPSEEK_BASE_URL` at a local stand-in started by `scripts/e2e-server.mjs`.

**Journals.** A journal is a folder with a `journals` row (`POST /api/nodes` with `journal`). `journal_entries` maps each entry note to its day; `worker/journals.ts` files new entries in year/month folders and returns an existing day instead of a duplicate. New entries start with the date heading and the device sends the body, so encrypted journals seal it like any note. Details in `docs/journals.md`.

**Clips.** 随手记 is a persistent clipboard outside the node tree: rows in `clips` (text inline, sealed-text prefix when encrypted; an optional image in `blob_id`; `site.clip_key_id` is the key for new ones), API in `worker/clips.ts`. The note being edited registers in `src/note-insert.ts` so clips can be inserted at its cursor. Devices pick clip IDs and queue new clips in a localStorage outbox (`src/clips.ts`) that is sent when online; the panel is `QuickClips`, opened by the `note:clips` window event. Details in `docs/quick-clips.md`.

**Encryption.** Any node can be encrypted with a password (`nodes.encryption`: NULL inherits, `'none'`, or a key ID; the effective key is `key_id` from `KEY_SQL`). Content keys live wrapped in `encryption_keys`; sealed objects carry their key in `blobs.key_id` and the `XVE1` header (`shared/encryption.ts`), short D1 fields use the sealed-text prefix. Devices seal bodies, files and annotations themselves (`sealWrite` in `src/api.ts`) and decrypt responses in `reveal()` (`src/encryption.ts`); keys unlocked on a device are in `src/keyring.ts`. Only Worker-processed features (青藜, translation, books, projects) receive keys, via `x-note-keys` → `withKeys()` in `worker/encryption.ts`; any new server-side read of content must go through `readText`/`readBytes` and any new write through `storeText(…, keyId)`. Re-encryption replaces objects in place under the same ID (`syncEncryption`). Details in `docs/encryption.md`.

**Shared contracts.** `shared/` is imported by both `src/` and `worker/`: API types, limits, SVG sanitizer, SSE parsing, assistant token budgeting (`shared/ai-context.ts`) and the backup format. Change limits and types there. New tables need entries in `shared/backup.ts` and restore in `worker/backups.ts`.

**Search.** `/api/search` matches titles, bodies and annotations. Unencrypted Markdown/text bodies are kept as plain text in `note_text` with an FTS5 trigram index (`worker/note-text.ts`), written in the same batch as each new version and backfilled by `indexPending()`; encrypted bodies are never indexed and are searched on the device (`src/local-search.ts`). Details in `docs/search.md`.

**AI.** `worker/deepseek.ts` stores the API key encrypted with a key derived from `APP_SECRET` and makes provider calls. `worker/assistant.ts` handles per-node threads plus a global thread (`GLOBAL_ASSISTANT_ID = 'qingli-global'`), streamed over SSE. Budgets are checked before any paid call; paid requests are never retried automatically.

**Frontend.** All API calls go through `api()` in `src/api.ts`, which waits for the Android proxy (`proxyReady`) and falls back to the IndexedDB cache (`src/offline-cache.ts`) for whitelisted GETs when offline. `NotePane` shows a cached copy of a note first and swaps in the server's answer, holding edits until then. Papers are sanitized once per content and cached (`preparePaper` in `PaperView.tsx`). `scripts/offline-shell.ts` generates `/sw.js` for the web build only. Cache invariants are in `docs/offline-reading.md`.

**Android.** `vite build --mode android` writes `dist-android/` (PDF.js `legacy` build). The WebView serves bundled assets at the chosen server's HTTPS origin (`ServerConfig.java` rewrites Capacitor's hostname; default `note.xvi.app`); only same-origin `/api/` goes to the network. `NoteProxyNetwork` routes the WebView and native requests through a user-configured external SOCKS5/HTTP proxy, checked on use, falling back to direct while it is down. Details in `docs/android.md` and `docs/network-proxy.md`.

**Testing.** The `worker` Vitest project runs in workerd via `@cloudflare/vitest-pool-workers` with migrations from `TEST_MIGRATIONS`; tests call the worker directly or via `SELF.fetch`, reset tables in `beforeEach`, and run serially. The `client` project runs `src/**/*.test.ts(x)` with fake-indexeddb (`src/test-setup.ts`). E2E specs import `test` from `e2e/fixtures.ts` (see `e2e/AGENTS.md`).

## Commands

Use Node.js 22.12+ and install with `npm ci` (pnpm also works).

- `npm run dev`: initialize local secrets and migrations, then start Vite and Wrangler. Keep `.wrangler/state` (local data); Playwright only resets `.wrangler/e2e/state`.
- `npm run db:local` applies migrations to local D1 (`npm run dev` does it too).
- `npm run check` (TypeScript), `npm run lint` (oxlint, fails on warnings; explain any `oxlint-disable`). TypeScript 7 has no JS API, so typescript-eslint cannot be used.
- `npm test` (Vitest: `worker` project in workerd, `client` project in happy-dom). Single file: `npx vitest run tests/library.test.ts`, add `-t '<name>'` for one test.
- `npm run test:e2e` serves the built `dist/`, so run `npm run build` first. Single spec: `npx playwright test e2e/notebook.spec.ts --project=desktop`.
- `pnpm run deploy`: build, migrate production D1, deploy. Keep `run`; bare `pnpm deploy` is a different command. Deploying the site does not update installed APKs.
- Android (JDK 21, Android SDK 37): `npm run android:apk`, `pnpm install:android`, `node scripts/android.mjs testDebugUnitTest`, `node scripts/android.mjs lintDebug`.

## Source ownership

All application source and assets are maintained in this repository. Edit local files directly; do not restore cross-project synchronization or filesystem dependencies. Theme tokens originate in `scripts/theme/brand-theme.ts`; run `npm run theme:sync` after editing it and `npm run theme:check` to verify the generated CSS.

## Conventions

- User-facing text, error messages, README and `docs/` are Simplified Chinese; code comments and commits are English.
- Match surrounding code. Base styles live in `src/styles.css`; `src/shell.css` only adds family-specific rules.
- Docs describe current behavior. Do not add dated validation logs or version histories; release notes go in `docs/releases/<version>.txt`.
- Topic docs: Android in `docs/android.md`, offline cache in `docs/offline-reading.md`, encryption in `docs/encryption.md`, journals in `docs/journals.md`, clips in `docs/quick-clips.md`, search in `docs/search.md`, proxy in `docs/network-proxy.md`, icons and splash in `docs/branding.md` (follow it for any artwork change), Cloudflare in `docs/cloudflare-deployment.md`.

## Testing

Mock DeepSeek; never call the real API in tests. Cover changed behavior and its failure paths; there is no coverage threshold. Check visual changes in the light, dark and starry themes on desktop and phone viewports.

## Commits

Concise imperative subjects, usually `feat:` / `fix:` / `perf:` / `refactor:` with optional scope such as `fix(android):`. Keep commits focused.

## Security

Keep secrets, signing keys, `.dev.vars` and generated APKs out of Git.
