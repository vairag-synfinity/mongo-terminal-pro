import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Integration tests share one disposable MongoDB; run files sequentially.
    fileParallelism: false,
  },
});
