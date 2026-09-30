import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the production build (`npm run build` first) served by `vite preview`,
 * against a real homeserver (e2e/start-homeserver.sh). See e2e/README.md.
 */
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  // Signing in sets up the Rust crypto (WASM) and a first sync: seconds, not milliseconds.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // Each test makes its own users and rooms, so they can run side by side.
  fullyParallel: true,
  workers: ci ? 2 : undefined,
  forbidOnly: ci,
  // One retry in CI so a flake doesn't block a merge, but it's still reported as flaky.
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !ci,
  },
});
