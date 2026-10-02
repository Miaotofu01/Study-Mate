// 探索 agent 的 Playwright 配置（草案）：复用 e2e 的 webServer（fixture 后端 8290 + 前端 dev 3810）
// 与 globalSetup（每轮重建种子工作区），探索跑在确定性的 fixture 世界上。
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const BACKEND_PORT = 8290;
const FRONTEND_PORT = 3810;
const WEB_ROOT = path.resolve(__dirname, "..");
const E2E_WORKSPACE = path.join(WEB_ROOT, "data", "e2e-ws");
const E2E_DATA_DIR = path.join(WEB_ROOT, "data", "e2e-data");

export default defineConfig({
  testDir: "./tests/explorer",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30 * 60 * 1000,
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
  },
  projects: [
    {
      name: "explorer",
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
      // 不复用：共享端口上出现别的（如开发者自己的）dev:e2e 时，必须启动失败，
      // 而不是静音复用它——那会让浏览器经对方前端代理到它的后端，探索错误的世界。
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev:e2e",
      env: { BACKEND_PORT: String(BACKEND_PORT) },
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
