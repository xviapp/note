# Repository Guidelines

## Commands

Use Node.js 22.12+ and install with `npm ci` (pnpm also works).

- `npm run dev`: initialize local secrets and migrations, then start Vite and Wrangler. Keep `.wrangler/state` (local data); Playwright only resets `.wrangler/e2e/state`.
- `npm run db:local` applies migrations to local D1 (`npm run dev` does it too).
- `npm run check` (TypeScript), `npm run lint` (oxlint, fails on warnings; explain any `oxlint-disable`). TypeScript 7 has no JS API, so typescript-eslint cannot be used.
- `npm test` (Vitest: `worker` project in workerd, `client` project in happy-dom). Single file: `npx vitest run tests/library.test.ts`, add `-t '<name>'` for one test.
- `npm run test:e2e` serves the built `dist/`, so run `npm run build` first. Single spec: `npx playwright test e2e/notebook.spec.ts --project=desktop`.
- `pnpm run deploy`: build, migrate production D1, deploy. Keep `run`; bare `pnpm deploy` is a different command. Deploying the site does not update installed APKs.
- Android (JDK 21, Android SDK 37): `npm run android:apk`, `pnpm install:android`, `node scripts/android.mjs testDebugUnitTest`, `node scripts/android.mjs lintDebug`.

## Conventions

- User-facing text, error messages, README and `docs/` are Simplified Chinese; code comments and commits are English.
- Match surrounding code. Base styles live in `src/styles.css`; `src/shell.css` only adds family-specific rules.
- Docs describe current behavior. Do not add dated validation logs or version histories; release notes go in `docs/releases/<version>.txt`.
- Topic docs: Android in `docs/android.md`, offline cache in `docs/offline-reading.md`, proxy in `docs/network-proxy.md`, icons and splash in `docs/branding.md` (follow it for any artwork change), Cloudflare in `docs/cloudflare-deployment.md`.

## Testing

Mock DeepSeek; never call the real API in tests. Cover changed behavior and its failure paths; there is no coverage threshold. Check visual changes in the light, dark and starry themes on desktop and phone viewports.

## Commits

Concise imperative subjects, usually `feat:` / `fix:` / `perf:` / `refactor:` with optional scope such as `fix(android):`. Keep commits focused.

## Security

Keep secrets, signing keys, `.dev.vars` and generated APKs out of Git. The `android/v2ray/` module is GPL-3.0 and its proxy settings may contain node credentials: never commit exported proxy configurations.
