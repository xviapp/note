# Repository Guidelines

For icon or artwork changes, follow [docs/branding.md](docs/branding.md).

## Build, Test, and Development Commands

Use Node.js 22.12+ and install dependencies with `npm ci`. Package scripts also support pnpm.

- `npm run dev`: initialize local secrets and migrations, then start Vite and Wrangler.
- `npm run lint` fails on warnings. Explain any `oxlint-disable` comment.
- `npm run test:e2e` serves the built site; build first.
- `npm run android:apk` requires JDK 21 and Android SDK 36.
- `pnpm run deploy`: build, migrate production D1, and deploy. Keep `run`; bare `pnpm deploy` invokes a different command.

## Coding Style & Naming Conventions

Match existing hook naming. TypeScript 7 has no JS API, so typescript-eslint cannot be used; lint is oxlint (including React hook rules).

## Testing Guidelines

Mock DeepSeek responses. Preserve `.wrangler/state` development data (Playwright resets only `.wrangler/e2e/state`). No coverage threshold is configured; cover changed behavior and relevant failure paths. Verify visual changes across light, dark, and starry themes.

## Commit & Pull Request Guidelines

Use concise imperative subjects. History commonly uses `feat:`, `fix:`, and scoped forms such as `fix(android):`; plain imperative subjects also occur. Keep commits focused. PRs should explain behavior changes, list validation, link related issues, and include screenshots for UI changes.

## Security & Platform Notes

Keep secrets, signing keys, and generated APKs outside Git. For Android builds, testing, or releases, follow [docs/android.md](docs/android.md); website deployment does not update installed APK resources.
