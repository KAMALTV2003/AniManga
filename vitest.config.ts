import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@nexus-ai/agents': fromRoot('./packages/agents/src/index.ts'),
      '@nexus-ai/capabilities': fromRoot('./packages/capabilities/src/index.ts'),
      '@nexus-ai/core': fromRoot('./packages/core/src/index.ts'),
      '@nexus-ai/config': fromRoot('./packages/config/src/index.ts'),
      '@nexus-ai/database': fromRoot('./packages/database/src/index.ts'),
      '@nexus-ai/observability': fromRoot('./packages/observability/src/index.ts'),
      '@nexus-ai/skills': fromRoot('./packages/skills/src/index.ts'),
      '@nexus-ai/harvest': fromRoot('./packages/harvest/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/src/index.ts'],
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 65,
      },
    },
  },
});
