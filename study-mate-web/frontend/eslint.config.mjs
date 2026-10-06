// 官方 Next flat config（eslint-config-next 16 / ESLint 9）：默认导出即一个 flat config 数组，
// 内含 Next、react、react-hooks、jsx-a11y 与 typescript-eslint 的推荐规则。
// 只补忽略项与少量降级，不加风格规则——目标是用真实 lint 拦住错误，不是统一排版。
import nextConfig from "eslint-config-next";

// React 19 编译器诊断（eslint-plugin-react-hooks v7 随 eslint-config-next 16 默认开启为 error）。
// 既有代码里有两类刻意、成规模的模式会被它们判错：
//   1) 渲染期写 latest ref（`xRef.current = x`）——用于事件/异步回调读取最新值；
//   2) effect 内同步 setState——水合后读 localStorage/主题、或加载开始时先清空列表。
// 这两类属于「React Compiler 迁移」议题，不是经典 hooks 正确性；rules-of-hooks(error) 与
// exhaustive-deps(warn) 保持官方默认不动。降级为 warn：问题仍可见，但不阻断 CI；逐文件重构
// 应由组件归属方安排，不在本次仅配置+workflow 的改动里动别人的代码。
const compilerDiagnosticsToWarn = [
  "react-hooks/immutability",
  "react-hooks/refs",
  "react-hooks/set-state-in-effect",
];

const config = [
  ...nextConfig,
  {
    rules: Object.fromEntries(compilerDiagnosticsToWarn.map((rule) => [rule, "warn"])),
  },
  {
    ignores: [
      "node_modules/**",
      // 各套 Next 构建产物：默认 .next、E2E 的 .next-e2e、探索的 .next-explorer
      ".next/**",
      ".next-*/**",
      // 运行时数据与测试产物（见 study-mate-web/.gitignore）
      "data/**",
      "test-results/**",
      "playwright-report/**",
      // 由 next dev/build 生成，不手改
      "next-env.d.ts",
    ],
  },
];

export default config;
