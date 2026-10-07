"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

export function GenerateWizard() {
  const router = useRouter();
  const { refreshSubjects, activeWorkspace } = useWorkspace();

  // E2E 水合标记：页面其余部分全是 SSR 静态内容，测试需要一个“React 已接管”的信号
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [level, setLevel] = useState("");
  const [background, setBackground] = useState("");
  const [project, setProject] = useState("");
  const [carrier, setCarrier] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);

  const submit = async () => {
    const trimmed = {
      name: name.trim(),
      purpose: purpose.trim(),
      level: level.trim(),
      background: background.trim(),
      project: project.trim(),
      carrier: carrier.trim(),
    };
    if (!trimmed.name || !trimmed.purpose || !trimmed.level || !trimmed.background) {
      setFormError("带 * 的四项为必填");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setError(null);
    setProblems(null);
    try {
      const res = await api.generateCourse(
        {
          name: trimmed.name,
          purpose: trimmed.purpose,
          level: trimmed.level,
          background: trimmed.background,
          project: trimmed.project || undefined,
          carrier: trimmed.carrier || undefined,
        },
        activeWorkspace,
      );
      await refreshSubjects();
      router.push(`/courses?subject=${encodeURIComponent(res.summary.slug)}`);
    } catch (err) {
      if (err instanceof ApiError && err.problems && err.problems.length > 0) {
        setProblems(err.problems);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto" data-hydrated={hydrated ? "true" : undefined}>
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-10">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-brand" />
          <h1 className="text-lg font-semibold">AI 生成科目</h1>
        </div>
        <p className="text-sm opacity-60">
          AI 根据你的五项描述生成课程大纲，并通过上游脚本门禁校验后落盘。
        </p>

        <Field label="科目名称" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：计算机网络"
            className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        <Field label="学习目的" required>
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            placeholder="例如：能为后端服务排查常见网络故障，看懂抓包结果"
            className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        <Field label="当前程度" required>
          <textarea
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            rows={2}
            placeholder="例如：日常用 HTTP 接口，但对 TCP/IP 分层只有模糊印象"
            className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        <Field label="前置基础" required>
          <textarea
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            rows={2}
            placeholder="例如：会 Python，写过简单命令行脚本，没用过 socket"
            className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        <Field label="配套项目（可选）">
          <input
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="例如：从零写一个带重试与超时的 HTTP 客户端"
            className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        <Field label="实验载体（可选）">
          <input
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            placeholder="例如：Docker 容器 + Wireshark 抓包"
            className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
        </Field>

        {formError && <p className="text-sm text-red-500">{formError}</p>}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {problems && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              大纲被上游校验脚本拦截，可调整描述重试
            </div>
            <ul className="list-disc pl-5 text-xs opacity-80">
              {problems.map((p, i) => (
                <li key={i} className="whitespace-pre-wrap break-words">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={() => void submit()}
          disabled={submitting}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm text-white transition-colors hover:bg-brand-light disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {submitting ? "生成中，约需一到两分钟…" : "生成课程大纲"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium opacity-70">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
