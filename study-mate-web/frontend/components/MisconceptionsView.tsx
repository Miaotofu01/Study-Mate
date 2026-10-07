"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import { AlertCircle, Loader2, NotebookPen, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import type {
  GraphNode,
  MisconceptionImportance,
  MisconceptionItem,
  MisconceptionPayload,
} from "@/lib/types";

const IMPORTANCE_OPTIONS: MisconceptionImportance[] = ["high", "medium", "low"];

const IMPORTANCE_LABEL: Record<MisconceptionImportance, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const IMPORTANCE_BADGE: Record<MisconceptionImportance, string> = {
  high: "bg-red-500/15 text-red-600 dark:text-red-400",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  low: "bg-[var(--muted)]",
};

interface FormState {
  topic: string;
  question: string;
  misunderstanding: string;
  answer_summary: string;
  follow_up: string;
  importance: MisconceptionImportance;
  node: string;
}

const EMPTY_FORM: FormState = {
  topic: "",
  question: "",
  misunderstanding: "",
  answer_summary: "",
  follow_up: "",
  importance: "medium",
  node: "",
};

export function MisconceptionsView() {
  const searchParams = useSearchParams();
  const { subjects, activeWorkspace, misconceptionDraft, setMisconceptionDraft } = useWorkspace();

  const [subjectSlug, setSubjectSlug] = useState(searchParams.get("subject") ?? "");
  const [importance, setImportance] = useState<MisconceptionImportance | "">("");
  // 支持从节点详情/图谱带参进入（?node= 预填筛选）
  const [nodeId, setNodeId] = useState(searchParams.get("node") ?? "");

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [items, setItems] = useState<MisconceptionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MisconceptionItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const draftConsumed = useRef(false);

  // 挂载时消费全局 draft：预填新建表单并预选科目
  useEffect(() => {
    if (draftConsumed.current) return;
    draftConsumed.current = true;
    if (!misconceptionDraft) return;
    if (misconceptionDraft.subject) setSubjectSlug(misconceptionDraft.subject);
    setNodeId(misconceptionDraft.node ?? "");
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      topic: misconceptionDraft.topic ?? "",
      question: misconceptionDraft.question ?? "",
      answer_summary: misconceptionDraft.answer_summary ?? "",
      node: misconceptionDraft.node ?? "",
    });
    setFormOpen(true);
    setMisconceptionDraft(null);
  }, [misconceptionDraft, setMisconceptionDraft]);

  // 选科目后拉节点（筛选下拉与表单节点选择共用）
  useEffect(() => {
    if (!subjectSlug) {
      setNodes([]);
      return;
    }
    let alive = true;
    api
      .getCourse(subjectSlug, activeWorkspace)
      .then((detail) => {
        if (alive) setNodes(detail.graph.nodes);
      })
      .catch(() => {
        if (alive) setNodes([]);
      });
    return () => {
      alive = false;
    };
  }, [subjectSlug, activeWorkspace]);

  useEffect(() => {
    if (!subjectSlug) {
      setItems([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .listMisconceptions(
        subjectSlug,
        {
          importance: importance || undefined,
          node_id: nodeId || undefined,
        },
        activeWorkspace,
      )
      .then((res) => {
        if (alive) setItems(res.items);
      })
      .catch((err) => {
        if (alive) {
          setItems([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [subjectSlug, importance, nodeId, activeWorkspace]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, node: nodeId });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (item: MisconceptionItem) => {
    setEditing(item);
    setForm({
      topic: item.topic,
      question: item.question,
      misunderstanding: item.misunderstanding,
      answer_summary: item.answer_summary,
      follow_up: item.follow_up ?? "",
      importance: item.importance,
      node: item.node ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setFormError(null);
  };

  const submitForm = async () => {
    if (!subjectSlug) {
      // 概念本按科目归档，未选科目时给出可见提示而不是静默失败
      setFormError("请先选择科目再保存");
      return;
    }
    const topic = form.topic.trim();
    const question = form.question.trim();
    const misunderstanding = form.misunderstanding.trim();
    const answerSummary = form.answer_summary.trim();
    if (!topic || !question || !misunderstanding || !answerSummary) {
      setFormError("主题、问题、误解点、答案要点均为必填");
      return;
    }
    const followUp = form.follow_up.trim();
    const payload: MisconceptionPayload = {
      topic,
      question,
      misunderstanding,
      answer_summary: answerSummary,
      importance: form.importance,
      // 显式带上这两个可空字段：编辑时「清空待跟进 / 取消节点关联」要能落盘。
      // 后端对省略的键按「保留旧值」处理，只传非空值会清不掉。
      follow_up: followUp ? followUp : null,
      node: form.node ? form.node : null,
    };

    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await api.updateMisconception(subjectSlug, editing.id, payload, activeWorkspace);
      } else {
        await api.createMisconception(subjectSlug, payload, activeWorkspace);
      }
      closeForm();
      const res = await api.listMisconceptions(
        subjectSlug,
        {
          importance: importance || undefined,
          node_id: nodeId || undefined,
        },
        activeWorkspace,
      );
      setItems(res.items);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (item: MisconceptionItem) => {
    if (!subjectSlug) return;
    if (!window.confirm(`删除概念「${item.topic}」？`)) return;
    try {
      await api.deleteMisconception(subjectSlug, item.id, activeWorkspace);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const nodeOptions = (current: string) => {
    if (current && !nodes.some((n) => n.id === current)) {
      return [{ id: current, title: current } as GraphNode, ...nodes];
    }
    return nodes;
  };

  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部筛选 */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-5 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <select
          value={subjectSlug}
          onChange={(e) => {
            setSubjectSlug(e.target.value);
            setNodeId("");
          }}
          className="max-w-[11rem] truncate rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
          style={{ borderColor: "var(--border)" }}
          title="学科"
          aria-label="学科"
        >
          <option value="">选择科目…</option>
          {subjects.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {(["", "high", "medium", "low"] as const).map((opt) => (
            <button
              key={opt || "all"}
              onClick={() => setImportance(opt)}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                importance === opt
                  ? "border-brand bg-brand/10 text-brand"
                  : "hover:bg-[var(--muted)]",
              )}
              style={importance === opt ? undefined : { borderColor: "var(--border)" }}
            >
              {opt === "" ? "全部" : IMPORTANCE_LABEL[opt]}
            </button>
          ))}
        </div>

        <select
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
          disabled={!subjectSlug}
          className="max-w-[11rem] truncate rounded-lg border bg-transparent px-2 py-1 text-xs outline-none disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
          title="节点"
          aria-label="节点"
        >
          <option value="">全部节点</option>
          {nodeOptions(nodeId).map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>

        <div className="ml-auto">
          <button
            onClick={openCreate}
            className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-xs text-white hover:bg-brand-light"
          >
            <Plus className="h-3.5 w-3.5" />
            记一条
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-5">
          {!subjectSlug && (
            <div className="flex flex-col items-center justify-center gap-1 py-24 text-center">
              <NotebookPen className="mb-2 h-8 w-8 opacity-30" />
              <p className="text-sm opacity-60">先选择一门科目查看概念本。</p>
              <p className="text-xs opacity-40">
                聊天中 assistant 消息右侧的「记入概念本」按钮可把问答一键存到这里。
              </p>
            </div>
          )}

          {subjectSlug && loading && (
            <div className="flex justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin opacity-50" />
            </div>
          )}

          {subjectSlug && !loading && error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {subjectSlug && !loading && !error && items.length === 0 && (
            <p className="py-16 text-center text-sm opacity-50">暂无概念本条目</p>
          )}

          {items.map((item) => (
            <div
              key={item.id}
              className="group rounded-xl border p-4"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span
                  className={clsx(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    IMPORTANCE_BADGE[item.importance],
                  )}
                >
                  {IMPORTANCE_LABEL[item.importance]}
                </span>
                <span className="text-xs opacity-50">{item.date}</span>
                {item.node && (
                  <Link
                    href={`/courses?subject=${encodeURIComponent(subjectSlug)}&node=${encodeURIComponent(item.node)}${
                      activeWorkspace ? `&workspace=${encodeURIComponent(activeWorkspace)}` : ""
                    }`}
                    className="max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--muted)]"
                    style={{ background: "var(--muted)" }}
                    title={`在课程图谱中定位：${nodeName(item.node)}`}
                  >
                    {nodeName(item.node)}
                  </Link>
                )}
              </div>

              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold leading-snug">{item.topic}</h3>
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => openEdit(item)}
                    className="rounded p-1 opacity-60 hover:bg-[var(--muted)] hover:opacity-100"
                    title="编辑"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void handleDelete(item)}
                    className="rounded p-1 opacity-60 hover:bg-[var(--muted)] hover:opacity-100"
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <CardSection label="问题">{item.question}</CardSection>
              <CardSection label="误解点">{item.misunderstanding}</CardSection>
              <CardSection label="答案要点">{item.answer_summary}</CardSection>
              {item.follow_up && <CardSection label="待跟进">{item.follow_up}</CardSection>}
            </div>
          ))}
        </div>
      </div>

      {/* 新建 / 编辑弹层 */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeForm}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "编辑概念" : "记入概念本"}
            className="flex max-h-[90vh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-2xl border bg-[var(--background)] p-5 shadow-xl"
            style={{ borderColor: "var(--border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editing ? "编辑概念" : "记入概念本"}
              </h2>
              <button
                onClick={closeForm}
                className="rounded p-1 opacity-50 hover:bg-[var(--muted)] hover:opacity-100"
                title="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <FormField label="科目" required>
              <select
                value={subjectSlug}
                aria-label="科目"
                onChange={(e) => {
                  setSubjectSlug(e.target.value);
                  // 节点按科目归档，切科目后清掉旧科目的节点选择
                  setNodeId("");
                  setForm((f) => ({ ...f, node: "" }));
                }}
                className="w-full truncate rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="">选择科目…</option>
                {subjects.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
            {!subjectSlug && (
              <p className="text-xs opacity-60">概念本按科目归档，请先选择科目后再保存。</p>
            )}

            <FormField label="主题" required>
              <input
                value={form.topic}
                onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
                placeholder="例如：把 TCP 三次握手记成了两次"
                className="w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </FormField>

            <FormField label="当时的问题" required>
              <textarea
                value={form.question}
                onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
                rows={3}
                placeholder="你当时问的是什么？"
                className="w-full resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </FormField>

            <FormField label="误解点" required>
              <textarea
                value={form.misunderstanding}
                onChange={(e) => setForm((f) => ({ ...f, misunderstanding: e.target.value }))}
                rows={3}
                placeholder="当时的错误理解是什么？"
                className="w-full resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </FormField>

            <FormField label="答案要点" required>
              <textarea
                value={form.answer_summary}
                onChange={(e) => setForm((f) => ({ ...f, answer_summary: e.target.value }))}
                rows={4}
                placeholder="正确理解的一句话总结"
                className="w-full resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </FormField>

            <FormField label="待跟进（可选）">
              <input
                value={form.follow_up}
                onChange={(e) => setForm((f) => ({ ...f, follow_up: e.target.value }))}
                placeholder="例如：下次用抓包验证一下 SYN/ACK"
                className="w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </FormField>

            <div className="flex gap-3">
              <FormField label="重要度" className="w-32">
                <select
                  value={form.importance}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, importance: e.target.value as MisconceptionImportance }))
                  }
                  className="w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                >
                  {IMPORTANCE_OPTIONS.map((imp) => (
                    <option key={imp} value={imp}>
                      {IMPORTANCE_LABEL[imp]}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="关联节点" className="flex-1">
                <select
                  value={form.node}
                  onChange={(e) => setForm((f) => ({ ...f, node: e.target.value }))}
                  className="w-full truncate rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
                  style={{ borderColor: "var(--border)" }}
                >
                  <option value="">不关联节点</option>
                  {nodeOptions(form.node).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            {formError && (
              <p className="break-all text-xs text-red-500">{formError}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={closeForm}
                className="rounded-lg px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
              >
                取消
              </button>
              <button
                onClick={() => void submitForm()}
                disabled={submitting || !subjectSlug}
                className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-light disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editing ? "保存修改" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CardSection({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mt-2">
      <div className="mb-0.5 text-[11px] font-medium opacity-50">{label}</div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed opacity-80">{children}</p>
    </div>
  );
}

function FormField({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={clsx("flex flex-col gap-1", className)}>
      <span className="text-xs opacity-60">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
