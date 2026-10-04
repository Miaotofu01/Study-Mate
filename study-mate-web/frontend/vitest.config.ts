import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 组件测试层（P4）：vitest + jsdom，与 playwright 的两套配置（tests/e2e、tests/explorer）
// 互不扫描——目录、文件名（*.test.tsx vs *.spec.ts）、运行器都分开。
// alias 与 tsconfig paths（"@/*": ["./*"]）保持一致。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/component/setup.ts"],
    include: ["tests/component/**/*.test.{ts,tsx}"],
  },
});
