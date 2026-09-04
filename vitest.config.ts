import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Le seed du catalogue est lent et les tests tapent une vraie base.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Une seule connexion à la fois : les tests partagent la même base.
    fileParallelism: false,
  },
});
