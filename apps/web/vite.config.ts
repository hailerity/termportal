import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const serverUrl = process.env.TERMPORTAL_SERVER_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@termportal/source'] },
  server: {
    port: 4200,
    // Same-origin in development: REST and WebSocket both go through the dev server.
    proxy: { '/api': { target: serverUrl, ws: true, changeOrigin: true } },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
