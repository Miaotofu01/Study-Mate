/** @type {import('next').NextConfig} */

const BACKEND_PORT = process.env.BACKEND_PORT || "8101";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || `http://127.0.0.1:${BACKEND_PORT}`;

const nextConfig = {
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
