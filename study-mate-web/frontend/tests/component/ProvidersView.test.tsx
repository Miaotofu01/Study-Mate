import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersView } from "@/components/settings/ProvidersView";
import { makeProvider, makeSettings } from "./fixtures";

// ProvidersView 只从 @/lib/api 导入 api；用例覆盖的三条空 key 分支：
// 回填输入框（load 预填真实 Key）、清空保存回落已存 Key、测试连接的 Key 携带与守卫。
const { api } = vi.hoisted(() => ({
  api: {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    testConnection: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api }));

async function renderView() {
  render(<ProvidersView />);
  // 锚定编辑区（load() 自动选中 active 提供商后打开）；「测试渠道」在列表行与编辑区出现两次，不能作锚点
  await screen.findByLabelText("API Key");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProvidersView 空 key 分支（E2E 从未观测「有 key」状态，在此下沉）", () => {
  it("有 key 渠道：API Key 输入框回填真实 Key（非掩码），保存原值不动", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    await renderView();
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.value).toBe("sk-stored");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings.mock.calls[0][0].providers[0]).toMatchObject({
      api_key: "sk-stored",
      has_key: true,
    });
  });

  it("清空 Key 输入后保存：回落到已存 Key，不会把 key 清没", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    await renderView();
    await userEvent.clear(screen.getByLabelText("API Key"));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings.mock.calls[0][0].providers[0]).toMatchObject({
      api_key: "sk-stored",
      has_key: true,
    });
  });

  it("无 key 渠道填入新 Key 保存：has_key 翻转为 true", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider({ has_key: false, api_key: "" })]));
    await renderView();
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.type(input, "sk-new");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings.mock.calls[0][0].providers[0]).toMatchObject({
      api_key: "sk-new",
      has_key: true,
    });
  });

  it("测试连接：携带回填的真实 Key 与首个可用模型，成功后显示延迟", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider()]));
    api.testConnection.mockResolvedValue({ latency_ms: 123, sample: "pong" });
    await renderView();
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
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

  it("空 key 渠道测试连接：以空 api_key 发出（后端按 provider_id 用已存口径处理）", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider({ has_key: false, api_key: "" })]));
    api.testConnection.mockResolvedValue({ latency_ms: 5, sample: "pong" });
    await renderView();
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledTimes(1));
    expect(api.testConnection.mock.calls[0][0]).toMatchObject({ api_key: "" });
  });

  it("Base URL 为空：测试连接被本地守卫拦截，不发请求", async () => {
    api.getSettings.mockResolvedValue(makeSettings([makeProvider({ base_url: "" })]));
    await renderView();
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("请先填写 Base URL 和至少一个模型名称")).toBeInTheDocument();
    expect(api.testConnection).not.toHaveBeenCalled();
  });
});
