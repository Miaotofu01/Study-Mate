import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 品牌色走 CSS 变量（globals.css 定义，暗色模式下自动换更亮调，支持蓝/绿调色方案），支持 /opacity 修饰
        brand: {
          DEFAULT: "rgb(var(--brand-rgb) / <alpha-value>)",
          light: "rgb(var(--brand-light-rgb) / <alpha-value>)",
          dark: "rgb(var(--brand-dark-rgb) / <alpha-value>)",
        },
        surface: {
          canvas: "var(--surface-canvas)",
          subtle: "var(--surface-subtle)",
          card: "var(--surface-card)",
          raised: "var(--surface-raised)",
        },
        paper: "#f7f3ea",
      },
      // 方向边框（border-t/b/l/r）不写颜色时默认跟随主题变量；否则会落到 Tailwind 内置的
      // 浅灰（#e5e7eb），在暗夜模式下表现为刺眼的白色细线
      borderColor: {
        DEFAULT: "var(--border)",
      },
      boxShadow: {
        raised: "var(--shadow-raised)",
        // Tailwind v3 的最小档是 shadow-sm，没有 v4 才引入的 shadow-xs；组件里已在用
        // shadow-xs（Composer/ChatView/GradingPanel/Sidebar/ThemeView），v3 下它是空类。
        // 这里补一个与 card 同色系（rgba 0.05）的最小投影，语义等同 v4 的 shadow-xs。
        xs: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
        card: "0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05)",
        floating: "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Noto Sans SC",
          "system-ui",
          "sans-serif",
        ],
        serif: [
          "var(--font-serif)",
          "Songti SC",
          "STSong",
          "Noto Serif SC",
          "Source Han Serif SC",
          "SimSun",
          "Georgia",
          "serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
