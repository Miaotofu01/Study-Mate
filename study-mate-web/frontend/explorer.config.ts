// 探索 agent 的 Playwright 配置（草案）：复用 e2e 的 webServer（fixture 后端 8290 + 前端 dev 3810）
// 与 globalSetup（每轮重建种子工作区），探索跑在确定性的 fixture 世界上。
import { defineConfig, devices } from "@playwright/test";

import { E2E_CONFIG_PATH, E2E_DATA_DIR, ensureWorkspaceConfig } from "./tests/e2e/constants";

const BACKEND_PORT = 8290;
const FRONTEND_PORT = 3810;

// 与 playwright.config.ts 同一套口径：工作区经配置文件发现（STUDYMATE_CONFIG 指到 e2e-data），
// 不用 STUDYMATE_WORKSPACE 注入（env 优先级最高，会架空 PUT /api/workspace）。
// 配置文件在 config 加载时就写好——Playwright 的 webServer 早于 globalSetup 启动。
ensureWorkspaceConfig();

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
        STUDYMATE_CONFIG: E2E_CONFIG_PATH,
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
