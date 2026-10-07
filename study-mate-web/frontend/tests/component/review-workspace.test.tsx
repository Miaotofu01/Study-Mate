import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { SystemPromptView } from "@/components/settings/SystemPromptView";
import { useChatDraft } from "@/lib/workspace";

const { getSettingsMock, saveSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  saveSettingsMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, getSettings: getSettingsMock, saveSettings: saveSettingsMock },
  };
});

// 会话级工作区透传回归（只读审查发现的 P1）。
const WS = "C:\\StudyMate\\ws-a";
const WS_B = "D:\\StudyMate\\ws-b";

function captureFetch(payload: unknown = { ok: true }) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input.toString());
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }),
  );
  return urls;
}

function workspaceOf(url: string): string | null {
  return new URL(url, "http://localhost").searchParams.get("workspace");
}

beforeEach(() => {
  getSettingsMock.mockResolvedValue({
    providers: [],
    active: { provider_id: "", model: "" },
    system_prompt: "旧的系统提示词",
    default_system_prompt: "后端默认提示词",
  });
  saveSettingsMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("科目类请求透传 workspace（带值）", () => {
  it("读/写/导出/练习/误解/课件列表都带同一个 workspace", async () => {
    const urls = captureFetch({ lessons: [], items: [], graph: { nodes: [], edges: [] } });
    const calls: Promise<unknown>[] = [
      api.getCourse("net", WS),
      api.patchCourse("net", { status: "暂停" }, WS),
      api.deleteCourse("net", WS),
      api.updateNodeProgress("net", "n1", { mastery: 0.5 }, WS),
      api.listMisconceptions("net", {}, WS),
      api.createMisconception("net", { topic: "t", question: "q", misunderstanding: "m", answer_summary: "a" }, WS),
      api.updateMisconception("net", "m1", { topic: "t" }, WS),
      api.deleteMisconception("net", "m1", WS),
      api.listLessons("net", WS),
      api.getQuiz("net", "n1", WS),
      api.gradeAnswer("net", "n1", { question: "q", criteria: "c", answer: "a" }, WS),
      api.listRecords("net", WS),
      api.generateSessionSummary("net", "s1", WS),
      api.exportCourse("net", WS),
      api.generateCourse({ name: "n", purpose: "p", level: "l", background: "b" }, WS),
      api.listTickets("net", true, WS),
      api.getTicket("t1", WS),
    ];
    await Promise.all(calls);
    expect(urls).toHaveLength(calls.length);
    for (const url of urls) {
      expect(workspaceOf(url), url).toBe(WS);
    }
  });

  it("createCourse 也带 workspace（新建科目落进当前工作区）", async () => {
    const urls = captureFetch({ slug: "n", name: "n" });
    await api.createCourse({ name: "n" }, WS);
    expect(workspaceOf(urls[0])).toBe(WS);
  });

  it("工单快改 / 放弃也带 workspace", async () => {
    const urls = captureFetch({ ok: true });
    await api.quickEditTicketArtifact("t1", "lessons/x.html", "<p/>", WS);
    await api.abandonTicket("t1", WS);
    for (const url of urls) expect(workspaceOf(url)).toBe(WS);
  });
});

describe("缺省 workspace 时保持旧调用形状（后端回落默认工作区）", () => {
  it("不给 workspace 就不带该 query", async () => {
    const urls = captureFetch({ lessons: [], items: [], graph: { nodes: [], edges: [] } });
    await Promise.all([
      api.getCourse("net"),
      api.listLessons("net"),
      api.getQuiz("net", "n1"),
      api.listMisconceptions("net"),
      api.createCourse({ name: "n" }),
      api.exportCourse("net"),
      api.listTickets("net", true),
      api.getTicket("t1"),
    ]);
    for (const url of urls) {
      expect(workspaceOf(url), url).toBeNull();
    }
  });

  it("null 与 undefined 等价（都视为默认工作区）", async () => {
    const urls = captureFetch({ graph: { nodes: [], edges: [] } });
    await api.getCourse("net", null);
    expect(workspaceOf(urls[0])).toBeNull();
  });
});

describe("课件文件 URL：绑定工作区走 /api/workspace-files 前缀，嵌套资源不丢工作区", () => {
  it("绑定工作区时路径形如 /api/workspace-files/<token>/courses/<slug>/files/...", () => {
    const url = api.courseFileUrl("net", "lessons/01-a b.html", WS);
    const base = api.workspaceFileBase(WS);
    expect(base).toBeTruthy();
    expect(url).toBe(`${base}/courses/net/files/lessons/01-a%20b.html`);
  });

  it("缺省时保持旧的默认工作区路由，且前缀为 null", () => {
    expect(api.courseFileUrl("net", "lessons/01.html")).toBe(
      "/api/courses/net/files/lessons/01.html",
    );
    expect(api.workspaceFileBase(null)).toBeNull();
    expect(api.workspaceFileBase(undefined)).toBeNull();
  });

  it("嵌套资源：课件页里的 ../../../assets 与 ../assets 解析后仍带工作区前缀", () => {
    const lessonUrl = new URL(
      api.courseFileUrl("net", "lessons/01-x.html", WS),
      "http://localhost",
    );
    const base = api.workspaceFileBase(WS)!;
    expect(new URL("../../../assets/sayo/sayo.css", lessonUrl).pathname).toBe(
      `${base}/courses/assets/sayo/sayo.css`,
    );
    expect(new URL("../assets/style.css", lessonUrl).pathname).toBe(
      `${base}/courses/net/files/assets/style.css`,
    );
  });

  it("工作区首页同理：/api/workspace-files/<token>/home/index.html 下 .learning/assets 不丢前缀", () => {
    const base = api.workspaceFileBase(WS)!;
    const homeUrl = new URL(`${base}/home/index.html`, "http://localhost");
    expect(new URL(".learning/assets/learn-theme.js", homeUrl).pathname).toBe(
      `${base}/home/.learning/assets/learn-theme.js`,
    );
  });

  it("同 slug 双工作区 → 不同前缀，不串资源", () => {
    const a = api.courseFileUrl("net", "lessons/01.html", WS);
    const b = api.courseFileUrl("net", "lessons/01.html", WS_B);
    expect(a).not.toBe(b);
    expect(a.startsWith(api.workspaceFileBase(WS)!)).toBe(true);
    expect(b.startsWith(api.workspaceFileBase(WS_B)!)).toBe(true);
  });
});

describe("useChatDraft：只有显式标注的「服务端新建会话」才迁移新对话草稿", () => {
  it("用户手动从新对话点开已有会话：不迁移，载入该会话自己的（空）草稿", () => {
    const { result, rerender } = renderHook(
      ({ id, adopt }: { id: string | null; adopt: string | null }) => useChatDraft(id, adopt),
      { initialProps: { id: null as string | null, adopt: null as string | null } },
    );
    // 新对话槽里写了一半，尚未发送（无服务端新建标记）
    act(() => {
      result.current.clearDraft();
      result.current.setValue("新对话里写了一半的草稿");
    });
    rerender({ id: "existing-session-manual-open", adopt: null });
    expect(result.current.value).toBe("");
  });

  it("服务端为本轮新建会话分配 id（显式标记）：保留流式期间新打的下一条草稿", () => {
    const { result, rerender } = renderHook(
      ({ id, adopt }: { id: string | null; adopt: string | null }) => useChatDraft(id, adopt),
      { initialProps: { id: null as string | null, adopt: null as string | null } },
    );
    act(() => {
      result.current.clearDraft();
      result.current.setValue("下一条消息");
    });
    rerender({ id: "server-created-session-1", adopt: "server-created-session-1" });
    expect(result.current.value).toBe("下一条消息");
  });

  it("标记与目标 id 不一致（非本轮新建）时同样不迁移", () => {
    const { result, rerender } = renderHook(
      ({ id, adopt }: { id: string | null; adopt: string | null }) => useChatDraft(id, adopt),
      { initialProps: { id: null as string | null, adopt: null as string | null } },
    );
    act(() => {
      result.current.clearDraft();
      result.current.setValue("半截草稿");
    });
    rerender({ id: "existing-session-mismatch", adopt: "some-other-session" });
    expect(result.current.value).toBe("");
  });

  it("在两个真实会话之间切换不串草稿", () => {
    const { result, rerender } = renderHook(
      ({ id, adopt }: { id: string | null; adopt: string | null }) => useChatDraft(id, adopt),
      { initialProps: { id: "draft-carry-a" as string | null, adopt: null as string | null } },
    );
    act(() => {
      result.current.setValue("A 的草稿");
    });
    rerender({ id: "draft-carry-b", adopt: null });
    expect(result.current.value).toBe("");
  });
});

describe("SystemPromptView：允许显式保存空串（清空即保存，依赖后端保存空值）", () => {
  it("清空后保存，saveSettings 收到 system_prompt 空串", async () => {
    render(<SystemPromptView />);
    const textarea = await screen.findByRole("textbox");
    await userEvent.clear(textarea);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ system_prompt: "" }),
      ),
    );
  });

  it("恢复默认使用后端提供的 default_system_prompt，而非当前自定义值", async () => {
    render(<SystemPromptView />);
    await screen.findByRole("textbox");
    await userEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(screen.getByRole("textbox")).toHaveValue("后端默认提示词");
    expect(screen.getByRole("textbox")).not.toHaveValue("旧的系统提示词");
  });
});
