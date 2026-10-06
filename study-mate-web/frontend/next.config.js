/** @type {import('next').NextConfig} */

const BACKEND_PORT = process.env.BACKEND_PORT || "8101";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || `http://127.0.0.1:${BACKEND_PORT}`;

// 构建/开发产物目录可由环境变量覆盖。E2E 与探索测试各自用独立目录
// （.next-e2e / .next-explorer），避免与开发者正在跑的 dev（默认 .next）共用同一
// distDir 而触发启动锁冲突。未设置时保持默认 .next，生产与手动启动行为完全不变。
// Next 会把该目录写进 next-env.d.ts 的类型导入；不同 distDir 是互不相交的根，
// 不会与 .next/types 串类型文件。
const DIST_DIR = process.env.STUDYMATE_NEXT_DIST || ".next";

const nextConfig = {
  distDir: DIST_DIR,
  // SSE（/api/chat/stream）不能被 gzip 缓冲，压缩关掉才能逐段流式
  compress: false,
  // 隐藏 dev 悬浮指示器，避免遮挡左下角控件（对 E2E 点击也必要）
  devIndicators: false,
  // 同源代理：浏览器只访问前端，/api/* 由 Next 转发到 FastAPI
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` },
    ];
  },
};

module.exports = nextConfig;
