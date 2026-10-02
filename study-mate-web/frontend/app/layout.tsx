import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import { WorkspaceProvider } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "StudyMate",
  description: "你的 AI 学习搭档：定计划、讲知识、做项目",
  // 标签页图标：public/icon-192.png（由 docs/images/logo.png 缩放到 192×192）
  icons: { icon: "/icon-192.png" },
};

// 首帧前写入 data-theme：localStorage 优先，否则跟随系统
const themeInit =
  "(function(){try{var t=localStorage.getItem('studymate-theme');" +
  "if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}" +
  "document.documentElement.dataset.theme=t;}catch(e){}})()";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <WorkspaceProvider>
          <div className="flex h-screen w-screen">
            <Sidebar />
            <main className="flex-1 overflow-hidden">{children}</main>
          </div>
        </WorkspaceProvider>
      </body>
    </html>
  );
}
