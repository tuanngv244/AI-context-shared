import { defineConfig } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('.local', { recursive: true });
writeFileSync('apps/dashboard/.tsconfig-ui.json', readFileSync('apps/dashboard/tsconfig.json'));
export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:13001',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command:
      'node node_modules/next/dist/bin/next dev apps/dashboard --hostname 127.0.0.1 --port 13001',
    url: 'http://127.0.0.1:13001',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      SCE_NEXT_DIST_DIR: '.next-ui',
      SCE_NEXT_TSCONFIG: '.tsconfig-ui.json',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
