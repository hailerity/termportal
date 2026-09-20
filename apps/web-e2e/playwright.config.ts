import { defineConfig, devices } from '@playwright/test';

// Dedicated ports so the suite never collides with `nx serve` running on the defaults.
const SERVER_PORT = 3199;
const WEB_PORT = 4299;
const repoRoot = new URL('../..', import.meta.url).pathname;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  // The scenarios share one server and assert on its session list.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run serve -w @termportal/server',
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      env: {
        PORT: String(SERVER_PORT),
        DEFAULT_SHELL: 'sh',
        LOG_LEVEL: 'warn',
        ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npm run serve -w @termportal/web -- --port ${WEB_PORT} --strictPort`,
      cwd: repoRoot,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { TERMPORTAL_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
