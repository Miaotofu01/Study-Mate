import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersView } from "@/components/settings/ProvidersView";
import { makeProvider, makeSettings } from "./fixtures";

// ProvidersView 现在**实时生效**（无「保存」按钮，编辑走 500ms 防抖落盘），连接测试入口
// 收敛到模型行的「测试」按钮（无「测试连接」按钮）。原来那 6 条断言「保存 / 测试连接」
// 按钮的用例在 2026-10-04 的两次 UI 改动后就一直红（层不进根门禁），这里按现行行为重写。
const { api } = vi.hoisted(() => ({
  api: {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    testConnection: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api }));

const SAVE_DEBOUNCE_MS = 700; // 组件是 500ms；留一点余量避免边界抖动

async function renderView() {
  render(<ProvidersView />);
  // 锚定编辑区（load() 自动选中 active 提供商后打开）；「测试渠道」在列表行与编辑区出现两次，不能作锚点
  await screen.findByLabelText("API Key");
}

/** 等防抖落盘发生一次，返回提交的 settings */
async function waitForSave() {
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalled(), {
    timeout: SAVE_DEBOUNCE_MS + 1500,
  });
  return api.saveSettings.mock.calls.at(-1)![0] as {
    providers: Array<Record<string, unknown>>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProvidersView 空 key 分支（E2E 从未观测「有 key」状态，在此下沉）", () => {
  it("有 key 渠道：API Key 输入框回填真实 Key（非掩码）", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    await renderView();
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.value).toBe("sk-stored");
    // 默认以密码点显示（另有「显示密钥」切换明文）
    expect(input.type).toBe("password");
  });

  it("清空 Key 输入后防抖落盘：回落到已存 Key，不会把 key 清没", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    await renderView();
    await userEvent.clear(screen.getByLabelText("API Key"));
    const saved = await waitForSave();
    expect(saved.providers[0]).toMatchObject({ api_key: "sk-stored", has_key: true });
  });

  it("无 key 渠道填入新 Key：has_key 翻转为 true", async () => {
    api.getSettings.mockResolvedValue(
      makeSettings([makeProvider({ has_key: false, api_key: "" })]),
    );
    await renderView();
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.type(input, "sk-new");
    const saved = await waitForSave();
    expect(saved.providers[0]).toMatchObject({ api_key: "sk-new", has_key: true });
  });

  it("模型行「测试」：携带回填的真实 Key 与模型名，成功后显示延迟", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    api.testConnection.mockResolvedValue({ latency_ms: 123, sample: "pong" });
    await renderView();
    await userEvent.click(screen.getByTitle("测试 model-a"));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledTimes(1));
    expect(api.testConnection.mock.calls[0][0]).toEqual({
      base_url: "https://api.example.com/v1",
      api_key: "sk-stored",
      api_format: "openai_chat",
      model: "model-a",
      provider_id: "p1",
    });
    expect(await screen.findByText(/连接成功 · 123 ms/)).toBeInTheDocument();
  });

  it("空 key 渠道点「测试」：以空 api_key 发出（后端按 provider_id 用已存口径处理）", async () => {
    api.getSettings.mockResolvedValue(
      makeSettings([makeProvider({ has_key: false, api_key: "" })]),
    );
    api.testConnection.mockResolvedValue({ latency_ms: 5, sample: "pong" });
    await renderView();
    await userEvent.click(screen.getByTitle("测试 model-a"));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledTimes(1));
    expect(api.testConnection.mock.calls[0][0]).toMatchObject({ api_key: "" });
  });

  it("Base URL 为空：测试被本地守卫拦截，不发请求", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider({ base_url: "" })]));
    await renderView();
    await userEvent.click(screen.getByTitle("测试 model-a"));
    expect(await screen.findByText("请先填写 Base URL")).toBeInTheDocument();
    expect(api.testConnection).not.toHaveBeenCalled();
  });
});
