"use client";

import clsx from "clsx";
import Link from "next/link";
import {
  AlertCircle,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Timer,
  Wrench,
  XCircle,
} from "lucide-react";
import Markdown from "./Markdown";
import { ErrorNotice } from "./ErrorNotice";
import { cleanAssistantParts, cleanAssistantText } from "@/lib/format";
import type {
  LessonLink,
  MessagePart,
  ProductionStatus,
  ProductionTask,
  TaskRole,
  TaskStage,
  ToolActivity,
} from "@/lib/types";

/**
 * 一次产课任务 = 一张卡（父 produce 工具一任务卡）：常显角色 / 阶段 / 已等待，展开看角色正文
 * 与工具过程；高频进度只刷新同一张卡（靠稳定 tool id，不重挂）。
 */

const TASK_STATUS_LABEL: Record<ProductionStatus, string> = {
  running: "进行中",
  done: "已完成",
  error: "失败",
  timeout: "超时",
  interrupted: "已中断",
};

const STAGE_STATUS_LABEL: Record<TaskStage["status"], string> = {
  running: "进行中",
  done: "完成",
  error: "失败",
};

function lessonFileLabel(file: string): string {
  return file.replace(/^\/?lessons\//, "");
}

function formatElapsed(seconds?: number): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return `${Math.round(seconds)}s`;
}

function isFallbackRole(role: TaskRole): boolean {
  return role.execution_mode === "fallback";
}

/** 备用派工角色的状态文案：运行中才说「正在」，终态如实说完成/失败/超时/中断。 */
function fallbackStatusText(status: ProductionStatus): string {
  if (status === "running") return "首次未交付，正在备用派工";
  if (status === "done") return "备用派工已完成";
  if (status === "timeout") return "备用派工超时";
  if (status === "interrupted") return "备用派工已中断";
  return "备用派工失败";
}

/** 调用时限文案：<=0 或缺省表示未设时限，不承诺有限等待。 */
function roleLimitLabel(role: TaskRole): string {
  return typeof role.max_seconds === "number" && role.max_seconds > 0
    ? `调用时限 ${Math.round(role.max_seconds)}s`
    : "未设时限，不承诺有限等待";
}

/**
 * 课件链接自带 workspace：iframe 里的共享资源相对引用会丢 query，工作区必须显式编进 URL；
 * 链接只来自服务端 LessonLink，不解析模型文本、不猜路径。
 */
export function lessonHref(lesson: LessonLink): string {
  const workspaceParam = lesson.workspace
    ? `&workspace=${encodeURIComponent(lesson.workspace)}`
    : "";
  return `/lesson?subject=${encodeURIComponent(lesson.subject_slug)}&node=${encodeURIComponent(
    lesson.node_id,
  )}${workspaceParam}`;
}

function TaskStatusIcon({ status }: { status: ProductionStatus }) {
  if (status === "running") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />;
  }
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  }
  if (status === "interrupted") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  if (status === "timeout") {
    return <Timer className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
}

function RoleToolCard({ tool }: { tool: ToolActivity }) {
  return (
    <details
      data-testid="tool-card"
      data-tool-id={tool.id}
      className={clsx("min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-xs", tool.status === "error" && "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300")}
      style={tool.status === "error" ? undefined : { borderColor: "var(--border)", background: "var(--muted)" }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5">
        {tool.status === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand" />
        ) : tool.status === "error" ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-emerald-500" />
        )}
        <span className="font-medium">{tool.name}</span>
        <span className="opacity-50">
          {tool.status === "running" ? "调用中…" : tool.status === "error" ? "返回错误" : "完成"}
        </span>
      </summary>
      <div className="mt-1.5 min-w-0 space-y-1">
        <div className="break-all">
          <span className="opacity-60">参数：</span>
          <code className="break-words">{tool.arguments || "{}"}</code>
        </div>
        {tool.result !== undefined && (
          <pre
            data-testid="tool-result"
            className="max-h-40 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-1.5 text-[11px] dark:bg-white/5"
          >
            {tool.result}
          </pre>
        )}
      </div>
    </details>
  );
}

/** 角色正文按 parts 保序渲染；reasoning 单独折叠，tool 由 tool_id 原位取。 */
function RoleBody({ role }: { role: TaskRole }) {
  const parts = cleanAssistantParts(role.parts ?? []);
  const fallbackTools = role.tools ?? [];
  return (
    <div
      data-testid="role-body"
      data-role-id={role.id}
      className="flex min-w-0 flex-col gap-1.5 border-t px-3 py-2"
      style={{ borderColor: "var(--border)" }}
    >
      {parts.length === 0
        ? fallbackTools.map((tool) => <RoleToolCard key={tool.id} tool={tool} />)
        : parts.map((part: MessagePart, index) => {
            if (part.type === "tool") {
              const tool = fallbackTools.find((item) => item.id === part.tool_id);
              return tool ? <RoleToolCard key={index} tool={tool} /> : null;
            }
            if (part.type === "text") {
              const text = cleanAssistantText(part.text);
              return text ? <Markdown key={index} content={text} /> : null;
            }
            if (part.type === "reasoning") {
              return (
                <details
                  key={index}
                  data-testid="role-reasoning"
                  className="rounded-lg border text-[11px]"
                  style={{ borderColor: "var(--border)" }}
                >
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 opacity-60">
                    <Brain className="h-3 w-3 shrink-0" />
                    思考
                    <ChevronDown className="ml-auto h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t px-2 py-1.5 opacity-70" style={{ borderColor: "var(--border)" }}>
                    <Markdown content={part.text} />
                  </div>
                </details>
              );
            }
            return (
              <div key={index} data-testid="role-notice" className="text-[11px] opacity-60">
                · {part.text}
              </div>
            );
          })}
    </div>
  );
}

function RoleRow({ role }: { role: TaskRole }) {
  const elapsed = formatElapsed(role.elapsed_s);
  return (
    <span
      data-testid="task-role"
      data-role-id={role.id}
      data-status={role.status}
      data-execution-mode={role.execution_mode ?? undefined}
      className="flex items-center gap-1 rounded-full border px-2 py-0.5"
      style={{ borderColor: "var(--border)" }}
    >
      <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", {
        "bg-brand": role.status === "running",
        "bg-emerald-500": role.status === "done",
        "bg-red-500": role.status === "error",
        "bg-amber-500": role.status === "interrupted" || role.status === "timeout",
      })} />
      <span className="font-medium">{role.name}</span>
      {isFallbackRole(role) && (
        <span
          data-testid="role-fallback-badge"
          className="rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400"
        >
          备用派工
        </span>
      )}
      <span className="opacity-50">
        {TASK_STATUS_LABEL[role.status]}
        {typeof role.round === "number" ? ` · 第 ${role.round} 轮` : ""}
        {elapsed ? ` · ${elapsed}` : ""}
      </span>
    </span>
  );
}

function StageRow({ stage }: { stage: TaskStage }) {
  return (
    <span
      data-testid="task-stage"
      data-stage-id={stage.id}
      data-status={stage.status}
      className={clsx("flex items-center gap-1", {
        "opacity-60": stage.status === "done",
        "text-brand": stage.status === "running",
        "text-red-500": stage.status === "error",
      })}
      title={stage.message}
    >
      {stage.status === "running" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : stage.status === "error" ? (
        <AlertCircle className="h-3 w-3 shrink-0" />
      ) : (
        <CheckCircle2 className="h-3 w-3 shrink-0" />
      )}
      <span className="font-medium">{stage.name}</span>
      <span>{STAGE_STATUS_LABEL[stage.status]}</span>
      {stage.message && <span className="opacity-60">· {stage.message}</span>}
    </span>
  );
}

export function ProductionTaskCard({ task, lesson }: { task: ProductionTask; lesson?: LessonLink }) {
  const link = lesson ?? task.lesson;
  const elapsed = formatElapsed(task.elapsed_s);
  const showLesson = Boolean(link) && task.status === "done";
  const roles = task.roles ?? [];
  const events = task.events ?? [];
  const fallbackRoles = roles.filter(isFallbackRole);

  return (
    <div
      data-testid="production-task-card"
      data-task-id={task.id}
      data-status={task.status}
      className="mb-2 min-w-0 rounded-xl border px-3 py-2 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--muted)" }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <TaskStatusIcon status={task.status} />
        <span data-testid="task-title" className="min-w-0 font-medium">
          {task.title || task.node_id}
        </span>
        <span
          data-testid="task-status"
          className={clsx(
            "rounded px-1.5 py-0.5",
            task.status === "done" && "text-emerald-600 dark:text-emerald-400",
            task.status === "error" && "text-red-600 dark:text-red-400",
            task.status === "interrupted" && "text-amber-600 dark:text-amber-400",
            task.status === "timeout" && "text-red-600 dark:text-red-400",
            task.status === "running" && "text-brand",
          )}
        >
          {TASK_STATUS_LABEL[task.status]}
        </span>
        {/* 「当前阶段」只在运行中有意义：终态记录即便带 stage 也绝不声称某阶段在跑 */}
        {task.stage && task.status === "running" && (
          <span data-testid="task-stage-current" className="opacity-60">
            当前阶段：{task.stage}
          </span>
        )}
        {typeof task.round === "number" && (
          <span data-testid="task-round" className="opacity-60">
            第 {task.round} 轮
          </span>
        )}
        {elapsed && (
          <span data-testid="task-elapsed" className="opacity-60">
            {task.status === "running" ? `已等待 ${elapsed}` : `耗时 ${elapsed}`}
          </span>
        )}
      </div>

      {roles.length > 0 && (
        <div data-testid="task-roles" className="mt-1.5 flex flex-wrap gap-1.5">
          {roles.map((role) => (
            <RoleRow key={role.id} role={role} />
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div data-testid="task-stages" className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 opacity-80">
          {events.map((stage) => (
            <StageRow key={stage.id} stage={stage} />
          ))}
        </div>
      )}

      {fallbackRoles.length > 0 && (
        <div data-testid="fallback-notes" className="mt-1.5 flex flex-col gap-1">
          {fallbackRoles.map((role) => {
            const roleElapsed = formatElapsed(role.elapsed_s);
            return (
              <p
                key={role.id}
                data-testid="fallback-note"
                data-role-id={role.id}
                data-status={role.status}
                className="text-amber-600 dark:text-amber-400"
              >
                <span data-testid="fallback-status">
                  备用派工：{fallbackStatusText(role.status)}
                </span>
                {role.fallback_reason && <span> · 原因：{role.fallback_reason}</span>}
                <span data-testid="fallback-wait">
                  {" "}· 本次角色等待 {roleElapsed ?? "—"}
                </span>
                <span data-testid="fallback-limit"> · {roleLimitLabel(role)}</span>
                <span data-testid="fallback-silent" className="opacity-70">
                  {" "}· 该角色为单次调用，期间无正文与子工具增量，可能长时间静默。
                </span>
              </p>
            );
          })}
        </div>
      )}

      {task.status === "error" && (
        <div data-testid="task-error"><ErrorNotice text={task.error || "产课失败"} /></div>
      )}
      {task.status === "interrupted" && (
        <p data-testid="task-interrupted" className="mt-1.5 text-amber-600 dark:text-amber-400">
          任务已中断，未完成；可从节点重新发起产课。
        </p>
      )}
      {task.status === "timeout" && (
        <div data-testid="task-timeout"><ErrorNotice text={task.error || "任务已超时，未完成；未取得完整交付，可从节点重新发起产课。"} /></div>
      )}

      {/* 成功常显入口：不藏进 details；Next Link 保持 SPA，切走课件不打断后台产课流 */}
      {showLesson && link && (
        <Link
          data-testid="open-lesson"
          href={lessonHref(link)}
          className="mt-2 flex w-fit items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-light"
          title={lessonFileLabel(link.file)}
        >
          <BookOpen className="h-3.5 w-3.5" />
          打开课件
        </Link>
      )}

      {roles.length > 0 && (
        <details data-testid="task-details" className="group mt-2 rounded-lg border" style={{ borderColor: "var(--border)" }}>
          <summary
            data-testid="task-details-summary"
            className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <span>角色过程 · {roles.length} 个角色</span>
            <ChevronDown className="ml-auto h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col">
            {roles.map((role) => (
              <div key={role.id} data-testid="task-role-block" data-role-id={role.id}>
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] opacity-70">
                  <span className="font-medium">{role.name}</span>
                  <span>{TASK_STATUS_LABEL[role.status]}</span>
                  {role.message && (
                    <span data-testid="role-message" className="opacity-80">· {role.message}</span>
                  )}
                </div>
                <RoleBody role={role} />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
