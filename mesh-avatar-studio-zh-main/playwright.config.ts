import { defineConfig } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  // Real layer builds and pixel comparisons must not compete for GPU/CPU resources.
  workers: 1,
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
  },
});
