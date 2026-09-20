import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const restricted = (names, reason) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: names.map((name) => ({ name, message: reason })),
      patterns: [
        {
          group: ['../../*/src/*', '**/packages/*/src/*'],
          message: 'Import workspace packages by name.',
        },
      ],
    },
  ],
});

export default tseslint.config(
  { ignores: ['**/dist', '**/out-tsc', '**/node_modules', '.nx', '**/coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The domain core stays portable: no transport, rendering, or PTY implementation imports.
    files: ['packages/terminal-core/**/*.ts'],
    rules: restricted(
      ['fastify', 'ws', 'node-pty', '@xterm/xterm', 'express'],
      'terminal-core must stay framework-independent (see docs/design.md §23).',
    ),
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: restricted(
      ['@termportal/terminal-core', '@termportal/terminal-pty', 'node-pty'],
      'The web client may only depend on api-contract and terminal-protocol.',
    ),
  },
);
