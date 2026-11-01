import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.RIVET_E2E_PORT ?? 8797);
// Point at a server you already run: RIVET_E2E_BASE_URL=http://localhost:5181 npx playwright test ...
const external = process.env.RIVET_E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 1024 } } }],
  webServer: external ? undefined : {
    command: `rm -rf .e2e-data && RIVET_DATA_DIR=.e2e-data RIVET_PORT=${port} RIVET_STAGE_MS=350 NODE_ENV=production RIVET_ALLOW_DEV_OUTBOX=1 RIVET_DISABLE_RATE_LIMITS=1 node --disable-warning=ExperimentalWarning server/index.ts`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
