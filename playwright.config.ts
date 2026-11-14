import { defineConfig } from "@playwright/test";
import os from "os";
import path from "path";

const port = Number(process.env.E2E_PORT || 3217);
const dataDir = path.join(os.tmpdir(), `icpc-e2e-${process.pid}`);

// The end-to-end test drives the built web app served by the real backend.
// Run `npm run build` first; `npm run test:e2e` does that for you.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node backend/dist/index.js",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      ICPC_DATA_DIR: dataDir,
      RUNNER_MODE: "direct",
      NODE_ENV: "test",
    },
  },
});
