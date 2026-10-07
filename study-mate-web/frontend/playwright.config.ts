import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { BACKEND_PYTHON, E2E_CONFIG_PATH, E2E_DATA_DIR, ensureWorkspaceConfig } from "./tests/e2e/constants";

const BACKEND_PORT = 8290;
const FRONTEND_PORT = 3810;
// 独立的 distDir：E2E dev server 不与开发者正在跑的 `npm run dev`（默认 .next）共用
// 同一构建目录，否则同目录两个 next dev 会在启动锁/产物上互相冲突。
const FRONTEND_DIST_DIR = ".next-e2e";
// study-mate-web/ 根：与 config.py 的 WEB_ROOT、global-setup 的落点保持一致（多一级就会把
// 后端指到仓库根的 data/，读到陈旧 fixture）
const WEB_ROOT = path.resolve(__dirname, "..");

// 工作区经配置文件发现（STUDYMATE_CONFIG），不再用 STUDYMATE_WORKSPACE 注入：
// env 覆盖优先级最高，会让 PUT /api/workspace 永远看不到效果（settings-workspace 用例要求
// 改路径后回显即时变化）。配置文件在 config 加载时就写好——Playwright 的 webServer 早于
// globalSetup 启动，迟到会让后端回落到真实 ~/StudyMate 并缓存整个轮次。
ensureWorkspaceConfig();

// 本地也强制 reuseExistingServer: false（与 explorer.config.ts 一致）：静默复用陈旧端口上的
// 后端/前端，会让整轮 E2E 跑在一个错误世界（旧代码 + 旧 fixture + 旧工作区发现结果），且失败
// 表现极其像"业务 bug"。宁可每轮重拉服务，换来环境一致性；上一轮就是这么踩坑的。

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
  // 渲染兜底矩阵（P3 的最小落地）：只把「关键浅/暗主题片段」的 toHaveCSS 断言放进
  // rendering.spec.ts，由两个独立项目各跑一次；主 e2e 项目 testIgnore 该文件，
  // 所以全量 E2E 不会被整套双倍跑。
  // CI smoke 走显式文件列表（chat-basic / courses），天然不含 rendering.spec.ts，仍 5 条。
  projects: [
    {
      name: "e2e",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /rendering\.spec\.ts/,
    },
    {
      name: "rendering-light",
      testMatch: /rendering\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], colorScheme: "light" },
    },
    {
      name: "rendering-dark",
      testMatch: /rendering\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
  ],
  webServer: [
    {
      command: `${BACKEND_PYTHON} -m uvicorn app.main:app --port 8290`,
      cwd: "../backend",
      env: {
        STUDYMATE_E2E_FIXTURE: "1",
        STUDYMATE_CONFIG: E2E_CONFIG_PATH,
        // 缺了它后端会回落到开发 data/（settings/sessions/exports 全读真实数据）
        STUDYMATE_DATA_DIR: E2E_DATA_DIR,
      },
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev:e2e",
      env: {
        BACKEND_PORT: String(BACKEND_PORT),
        STUDYMATE_NEXT_DIST: FRONTEND_DIST_DIR,
      },
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
