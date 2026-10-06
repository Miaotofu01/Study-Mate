import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionDialog } from "@/components/InspectionDialog";
import type { TicketDetail } from "@/lib/types";

// 旧工单恢复（R10）组件契约：
// 归属未知 → 明确提示「需要确认工作区」且禁写；用户显式选定/手输后点确认 → 服务端返回
// 持久归属 → 可写；放弃是 status-only、未知也能用；错误 / 409 清楚展示；正常单 UI 不变。

const A = "C:\\ws\\A";
const B = "C:\\ws\\B";

const { api, retryTicket, recheckTicket } = vi.hoisted(() => ({
  api: {
    getWorkspace: vi.fn(),
    getTicket: vi.fn(),
    confirmTicketWorkspace: vi.fn(),
    abandonTicket: vi.fn(),
    quickEditTicketArtifact: vi.fn(),
    draftFileUrl: vi.fn(() => "#"),
    courseFileUrl: vi.fn(() => "#"),
  },
  retryTicket: vi.fn(),
  recheckTicket: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api, retryTicket, recheckTicket }));

function makeTicket(over: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: "t-legacy",
    kind: "produce",
    slug: "net",
    node_id: null,
    base_label: "workspace",
    problems: [{ owner: "讲解", path: "lessons/01.md", line: "", message: "术语表缺少主题词" }],
    artifacts: ["lessons/01.md"],
    retries: 0,
    status: "待处理",
    created_at: 1,
    updated_at: 1,
    groups: { 讲解: [{ owner: "讲解", path: "lessons/01.md", line: "", message: "术语表缺少主题词" }] },
    base_dir: null,
    workspace: null,
    workspace_ambiguous: true,
    ...over,
  };
}

/** 归属未知的旧单：后端标记 ambiguous、base_dir=null、无 workspace */
const unknownTicket = makeTicket();
/** 确认归属到 B 之后的同一张单：有持久 workspace 与 base_dir */
const confirmedTicket = makeTicket({
  workspace: B,
  workspace_ambiguous: false,
  base_dir: `${B}\\.learning\\subjects\\net`,
});

beforeEach(() => {
  api.getWorkspace.mockResolvedValue({ candidates: [A, B] });
  api.getTicket.mockImplementation((_id: string, ws?: string | null) =>
    Promise.resolve(ws === B ? confirmedTicket : unknownTicket),
  );
  api.confirmTicketWorkspace.mockResolvedValue({ ok: true, ticket: confirmedTicket });
  api.abandonTicket.mockResolvedValue({ ok: true });
  api.quickEditTicketArtifact.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderDialog(props: Partial<Parameters<typeof InspectionDialog>[0]> = {}) {
  return render(
    <InspectionDialog
      ticketId="t-legacy"
      onClose={vi.fn()}
      onResolved={vi.fn()}
      onChanged={vi.fn()}
      {...props}
    />,
  );
}

describe("归属未知的旧工单", () => {
  it("显示「需要确认工作区」，解释不会自动选同名科目，确认前禁写", async () => {
    renderDialog();

    const panel = await screen.findByTestId("inspection-unknown");
    expect(panel).toHaveTextContent("需要确认工作区");
    expect(panel).toHaveTextContent("同名科目");
    // 产物按钮不可点（禁读，路径根未知）
    expect(screen.getByTestId("inspection-artifact")).toBeDisabled();
    // 会改产物的操作全部禁用
    expect(screen.getByTestId("inspection-retry-all")).toBeDisabled();
    expect(screen.getByTestId("inspection-recheck")).toBeDisabled();
    // 放弃是 status-only，未知也能用
    expect(screen.getByTestId("inspection-abandon")).not.toBeDisabled();
    // 没有自动认领：确认按钮未选前不可点
    expect(screen.getByTestId("inspection-confirm-ownership")).toBeDisabled();
    expect(api.confirmTicketWorkspace).not.toHaveBeenCalled();
  });

  it("显式选定候选工作区并确认归属后，服务端返回持久归属 → 可写", async () => {
    const onChanged = vi.fn();
    renderDialog({ onChanged });

    await screen.findByTestId("inspection-unknown");
    const candidates = screen.getAllByTestId("inspection-workspace-candidate");
    expect(candidates).toHaveLength(2);
    await userEvent.click(candidates[1]); // 选 B，不自动选 A
    await userEvent.click(screen.getByTestId("inspection-confirm-ownership"));

    await waitFor(() =>
      expect(api.confirmTicketWorkspace).toHaveBeenCalledWith("t-legacy", B),
    );
    // 归属确认后标记消失、写操作放行
    await waitFor(() => expect(screen.queryByTestId("inspection-unknown")).toBeNull());
    expect(screen.getByTestId("inspection-retry-all")).not.toBeDisabled();
    expect(screen.getByTestId("inspection-recheck")).not.toBeDisabled();
    expect(screen.getByTestId("inspection-artifact")).not.toBeDisabled();
    expect(onChanged).toHaveBeenCalled();
  });

  it("也支持手输工作区绝对路径（候选之外）", async () => {
    renderDialog();
    await screen.findByTestId("inspection-unknown");

    await userEvent.type(screen.getByTestId("inspection-workspace-manual"), A);
    await userEvent.click(screen.getByTestId("inspection-confirm-ownership"));

    await waitFor(() => expect(api.confirmTicketWorkspace).toHaveBeenCalledWith("t-legacy", A));
  });

  it("放弃工单：未知归属也调用 status-only 放弃（带当前 scope，不替未知单认领）", async () => {
    renderDialog();
    await screen.findByTestId("inspection-unknown");

    await userEvent.click(screen.getByTestId("inspection-abandon"));

    await waitFor(() => expect(api.abandonTicket).toHaveBeenCalledWith("t-legacy", A));
  });

  it("确认失败（如 422 工作区不存在）在面板内清楚展示", async () => {
    api.confirmTicketWorkspace.mockRejectedValue(new Error("422：工作区目录不存在"));
    renderDialog();
    await screen.findByTestId("inspection-unknown");

    await userEvent.click(screen.getAllByTestId("inspection-workspace-candidate")[0]);
    await userEvent.click(screen.getByTestId("inspection-confirm-ownership"));

    const err = await screen.findByTestId("inspection-confirm-error");
    expect(err).toHaveTextContent("422");
    // 失败后仍保持禁写，未误放行
    expect(screen.getByTestId("inspection-retry-all")).toBeDisabled();
  });

  it("放弃失败（如 409）在底部错误条清楚展示", async () => {
    api.abandonTicket.mockRejectedValue(
      new Error("409：旧工单未记录工作区，无法确认归属"),
    );
    renderDialog();
    await screen.findByTestId("inspection-unknown");

    await userEvent.click(screen.getByTestId("inspection-abandon"));

    const err = await screen.findByTestId("inspection-stream-error");
    expect(err).toHaveTextContent("放弃失败");
    expect(err).toHaveTextContent("409");
  });
});

describe("正常工单 UI 不变", () => {
  it("有归属的新单：不出现未知面板，写操作可用", async () => {
    const owned = makeTicket({
      id: "t-owned",
      workspace: A,
      workspace_ambiguous: false,
      base_dir: `${A}\\.learning\\subjects\\net`,
    });
    api.getTicket.mockResolvedValue(owned);

    renderDialog({ ticketId: "t-owned" });

    await screen.findByTestId("inspection-overview");
    expect(screen.queryByTestId("inspection-unknown")).toBeNull();
    expect(screen.getByTestId("inspection-retry-all")).not.toBeDisabled();
    expect(screen.getByTestId("inspection-recheck")).not.toBeDisabled();
    expect(screen.getByTestId("inspection-artifact")).not.toBeDisabled();
    // 有归属的单读取用其持久工作区（不经确认）
    await waitFor(() => expect(api.getTicket).toHaveBeenCalledWith("t-owned", A));
  });
});
