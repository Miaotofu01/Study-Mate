import pkg from "../../package.json";

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
        </div>
      </div>
    </div>
  );
}
