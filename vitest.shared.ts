import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prior build.
const conditions = ['@termportal/source'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
