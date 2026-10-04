import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "@/components/ModelSelector";
import { makeProvider, makeSettings } from "./fixtures";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const openMenu = async () => {
  await userEvent.click(screen.getByTitle("切换当前使用的提供商 / 模型"));
};

describe("ModelSelector 分支（E2E 状态分支层下沉）", () => {
  it("settings 为 null：显示「未配置」，点击跳转设置页", async () => {
    render(<ModelSelector settings={null} onUpdated={() => {}} />);
    await userEvent.click(screen.getByText("未配置"));
    expect(push).toHaveBeenCalledWith("/settings/providers");
  });

  it("providers 为空数组：同样走「未配置」分支", () => {
    render(<ModelSelector settings={makeSettings([])} onUpdated={() => {}} />);
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("空模型列表：下拉里出现「无模型」占位，不渲染模型行", async () => {
    const settings = makeSettings([makeProvider({ models: [] })]);
    render(<ModelSelector settings={settings} onUpdated={() => {}} />);
    await openMenu();
    expect(screen.getByText("无模型")).toBeInTheDocument();
    expect(screen.queryByText("model-a")).not.toBeInTheDocument();
  });

  it("空 key：has_key=false 的提供商带「未设 API Key」标记", async () => {
    const settings = makeSettings([makeProvider({ has_key: false, api_key: "" })]);
    render(<ModelSelector settings={settings} onUpdated={() => {}} />);
    await openMenu();
    expect(screen.getByText("未设 API Key")).toBeInTheDocument();
  });
});
