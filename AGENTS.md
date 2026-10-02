# Repository Guidelines

## Project Structure & Module Organization

- `src/`: React/TypeScript UI shared by Web and Capacitor Android; components in `src/components/`.
- `worker/`: Cloudflare API; `shared/`: common types and helpers.
- `migrations/`: numbered D1 SQL migrations. D1 stores metadata; private R2 stores bodies and files.
- `android/`: native shell; `scripts/`: development, packaging, and release tooling.
- `tests/`: Worker tests and fixtures; `e2e/`: browser tests.
- `assets/`: artwork sources; `public/`: served assets. For icon changes, follow [docs/branding.md](docs/branding.md).

## Build, Test, and Development Commands

Use Node.js 22.12+ and install dependencies with `npm ci`. Package scripts also support pnpm.

- `npm run dev`: initialize local secrets and migrations, then start Vite and Wrangler.
- `npm run check`: type-check frontend, backend, shared code, and tests.
- `npm run build`: generate resources and build the website into `dist/`.
- `npm test`: run Vitest Worker integration tests.
- `npm run test:e2e`: run desktop/mobile Playwright tests; build first.
- `npm run test:build` / `npm run test:android-cli`: check offline packaging / Android CLI behavior.
- `npm run android:apk`: build an APK; requires JDK 21 and Android SDK 36.
- `pnpm run deploy`: build, migrate production D1, and deploy. Keep `run`; bare `pnpm deploy` invokes a different command.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and single-quoted strings. Follow `.prettierrc.json`: trailing commas and 100-column wrapping. Components use PascalCase filenames; utilities generally use kebab-case. Match existing hook naming. Put shared API contracts in `shared/`. No standalone lint script is configured.

## Testing Guidelines

Name Worker tests `tests/*.test.ts` and browser scenarios `e2e/*.spec.ts`. Vitest uses workerd with local D1/R2; mock DeepSeek responses. Playwright runs desktop and mobile projects, resetting only `.wrangler/e2e/state`. Preserve `.wrangler/state` development data. No coverage threshold is configured; cover changed behavior and relevant failure paths. Verify visual changes across light, dark, and starry themes.

## Commit & Pull Request Guidelines

Use concise imperative subjects. History commonly uses `feat:`, `fix:`, and scoped forms such as `fix(android):`; plain imperative subjects also occur. Keep commits focused. PRs should explain behavior changes, list validation, link related issues, and include screenshots for UI changes.

## Security & Platform Notes

Keep secrets, signing keys, and generated APKs outside Git. For Android builds, testing, or releases, follow [docs/android.md](docs/android.md); website deployment does not update installed APK resources.
