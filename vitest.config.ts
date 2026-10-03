import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        // Worker integration tests run in workerd with local D1 and R2.
        plugins: [
          cloudflareTest({
            main: './worker/index.ts',
            miniflare: {
              compatibilityDate: '2026-10-01',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              r2Buckets: ['FILES'],
              bindings: {
                APP_SECRET: 'test-only-app-secret-not-for-deployment-0001',
                SETUP_TOKEN: 'test-only-setup-token-not-for-deployment-0001',
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['tests/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        // Client logic (caches, hooks, drag targeting) in a simulated browser.
        test: {
          name: 'client',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['src/test-setup.ts'],
        },
      },
    ],
  },
});
