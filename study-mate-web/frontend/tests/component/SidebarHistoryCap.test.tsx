import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import type { SessionMeta, SubjectMeta } from "@/lib/types";

// 2026-10-05 拍板①：会话 / 科目区块可折叠；会话默认只显示最近 5 条，
// 更多历史收进「展开历史会话」，活动会话即使在第 5 条之外也不被藏起来。
const { push, replace, workspace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  workspace: { current: {} as Record<string, unknown> },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/chat",
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => workspace.current,
}));

function makeSession(id: string, i: number): SessionMeta {
  return {
    id,
    title: `会话${i}`,
    message_count: 1,
    created_at: i,
    updated_at: i,
    subject_slug: null,
    node_id: null,
    mode: "chat",
    workspace: null,
    usage: null,
    active: null,
  };
}

function setWorkspace(over: Record<string, unknown>) {
  workspace.current = {
    sessions: [] as SessionMeta[],
    subjects: [] as SubjectMeta[],
    subjectsLoaded: true,
    activeSessionId: null,
    currentSubjectSlug: null,
    setCurrentSubjectSlug: vi.fn(),
    newSession: vi.fn(),
    openSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    createSubject: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("侧栏会话历史上限与区块折叠（拍板①）", () => {
  it("7 条会话默认只显示最近 5 条 + 展开按钮；活动会话在最旧也不被藏", () => {
    // 后端按 updated_at 降序返回：数组首项是最新的（id/title/updated_at 一一对应）
    const sessions = Array.from({ length: 7 }, (_, i) => makeSession(`s${6 - i}`, 6 - i));
    setWorkspace({ sessions, activeSessionId: "s0" }); // s0 最旧，不在前 5
    render(<Sidebar />);

    const visible = screen.getAllByText(/会话\d/);
    expect(visible).toHaveLength(6); // 5 条最新 + 被保留的活动会话 s0
    expect(screen.getByText("会话0")).toBeInTheDocument();
    expect(screen.queryByText("会话1")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-history-expand")).toHaveTextContent("还有 1 条");
  });

  it("展开显示全部历史，可再收起", async () => {
    const sessions = Array.from({ length: 7 }, (_, i) => makeSession(`s${i}`, i));
    setWorkspace({ sessions });
    render(<Sidebar />);

    await userEvent.click(screen.getByTestId("session-history-expand"));
    expect(screen.getAllByText(/会话\d/)).toHaveLength(7);
    expect(screen.getByTestId("session-history-collapse")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("session-history-collapse"));
    expect(screen.getAllByText(/会话\d/)).toHaveLength(5);
  });

  it("会话与科目区块各自折叠，互不影响", async () => {
    const sessions = [makeSession("s0", 0)];
    const subjects = [{ slug: "math", name: "数学" }] as SubjectMeta[];
    setWorkspace({ sessions, subjects });
    render(<Sidebar />);

    // 折叠会话区块：会话行消失，科目不受影响（用全名匹配，避开「新对话」「新科目」）
    await userEvent.click(screen.getByRole("button", { name: "会话" }));
    expect(screen.queryByText("会话0")).not.toBeInTheDocument();
    expect(screen.getByText("数学")).toBeInTheDocument();

    // 折叠科目区块：科目行消失
    await userEvent.click(screen.getByRole("button", { name: "科目" }));
    expect(screen.queryByText("数学")).not.toBeInTheDocument();

    // 再展开回来
    await userEvent.click(screen.getByRole("button", { name: "会话" }));
    expect(screen.getByText("会话0")).toBeInTheDocument();
  });
});
