import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const BACKEND_PORT = 8290;
const FRONTEND_PORT = 3810;
// study-mate-web/ 根：与 config.py 的 WEB_ROOT、global-setup 的落点保持一致（多一级就会把
// 后端指到仓库根的 data/，读到陈旧 fixture）
const WEB_ROOT = path.resolve(__dirname, "..");
const E2E_WORKSPACE = path.join(WEB_ROOT, "data", "e2e-ws");
const E2E_DATA_DIR = path.join(WEB_ROOT, "data", "e2e-data");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "e2e",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: ".venv\\Scripts\\python.exe -m uvicorn app.main:app --port 8290",
      cwd: "../backend",
      env: {
        STUDYMATE_E2E_FIXTURE: "1",
        STUDYMATE_WORKSPACE: E2E_WORKSPACE,
        STUDYMATE_DATA_DIR: E2E_DATA_DIR,
      },
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run dev:e2e",
      env: { BACKEND_PORT: String(BACKEND_PORT) },
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
