import pkg from "../../package.json";

const START_COMMANDS = [
  { label: "一键启动", value: "study-mate-web/start-studymate.bat" },
  { label: "后端", value: "uvicorn app.main:app --port 8101（在 backend/ 下）" },
  { label: "前端开发", value: "next dev -p 3800" },
  { label: "前端生产", value: "next start -p 3800 | 3801" },
];

export function AboutView() {
  return (
    <div className="h-full px-6 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">关于 StudyMate Web</h1>
        <p className="mb-6 text-sm opacity-60">StudyMate 的独立 Web 运行时（FastAPI + Next.js）。</p>

        <div className="flex flex-col gap-4">
          <section
            className="rounded-2xl border p-5"
            style={{ borderColor: "var(--border)" }}
          >
            <h2 className="mb-2 text-sm font-semibold">版本</h2>
            <p className="text-sm">
              StudyMate Web <span className="font-mono text-brand">v{pkg.version}</span>
            </p>
            <p className="mt-1.5 text-xs opacity-60">
              版本仅标识本子项目，遵循语义化版本控制，与上游 npm 包{" "}
              <span className="font-mono">@yunmiao/studymate</span> 相互独立演进。
            </p>
          </section>

          <section
            className="rounded-2xl border p-5"
            style={{ borderColor: "var(--border)" }}
          >
            <h2 className="mb-2 text-sm font-semibold">上游项目</h2>
            <p className="text-sm">
              <span className="font-mono">@yunmiao/studymate</span>
              <span className="ml-2 text-xs opacity-60">
                寄生在 DSH / Antigravity / Codex 等 Agent 上的学习技能包 + 静态课程工作区生成器
              </span>
            </p>
            <p className="mt-1.5 text-xs opacity-60">
              课程图谱领域模型（curriculum.yaml / progress.yaml / subject.yaml）与插件侧共享同一套 schema。
            </p>
          </section>

          <section
            className="rounded-2xl border p-5"
            style={{ borderColor: "var(--border)" }}
          >
            <h2 className="mb-2 text-sm font-semibold">端口与启动</h2>
            <div className="flex flex-col gap-1.5">
              {START_COMMANDS.map((c) => (
                <div key={c.label} className="flex items-baseline gap-3 text-xs">
                  <span className="w-16 shrink-0 opacity-60">{c.label}</span>
                  <code
                    className="min-w-0 break-all rounded px-1.5 py-0.5 font-mono"
                    style={{ background: "var(--muted)" }}
                  >
                    {c.value}
                  </code>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs opacity-50">
              /api/* 由 Next rewrites 同源代理到 FastAPI；生产构建时代理目标在构建期固化。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
