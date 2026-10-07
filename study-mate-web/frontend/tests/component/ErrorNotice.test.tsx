import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { ErrorInfo } from "@/lib/types";

/**
 * ErrorNotice 组件回归：统一红错误卡的「红/中性分色 + 详情折叠 + 复制诊断」三件事。
 * 契约与 tests/e2e/chat-errors.spec.ts 保持一致（testid / role / data-error-tone）。
 */

const writeText = vi.hoisted(() => vi.fn());

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

/** 一份典型的 HTTP 503 上游错误（与 E2E 的 HTTP_503_ERROR_INFO 同形）。 */
const upstream503: ErrorInfo = {
  code: "upstream_http_503",
  status: 503,
  upstream_code: "503",
  phase: "request",
  summary: "模型服务暂时不可用，请稍后重试。",
  detail: "DeepSeek /chat/completions 返回 503 Service Unavailable",
  retryable: true,
  stopped_reason: null,
  request_id: "req-unit-503",
  source: "provider",
  operation: "chat_stream",
};

const userStopped: ErrorInfo = {
  code: "user_stopped",
  status: null,
  upstream_code: null,
  phase: "stream",
  summary: "已停止本轮回复。",
  detail: null,
  retryable: false,
  stopped_reason: "user_stop",
  request_id: "turn-stop",
};

describe("ErrorNotice（统一错误卡）", () => {
  it("503 上游错误：红底 + role=alert + code/phase + 状态徽标 + summary", () => {
    render(<ErrorNotice error={upstream503} />);
    const notice = screen.getByTestId("error-notice");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveAttribute("data-error-tone", "danger");
    expect(notice).toHaveAttribute("data-error-code", "upstream_http_503");
    expect(notice).toHaveAttribute("data-error-phase", "request");
    expect(screen.getByTestId("error-notice-summary")).toHaveTextContent(upstream503.summary);
    expect(screen.getByTestId("error-notice-badge")).toHaveTextContent("503");
  });

  it("详情默认收起；toggle 翻转 aria-expanded 并展开 detail", async () => {
    render(<ErrorNotice error={upstream503} />);
    const toggle = screen.getByTestId("error-notice-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("error-notice-detail")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByTestId("error-notice-detail");
    expect(detail).toHaveTextContent(upstream503.detail!);
    expect(detail).toHaveTextContent(upstream503.request_id!);
  });

  it("复制诊断信息：写剪贴板并给出已复制反馈", async () => {
    render(<ErrorNotice error={upstream503} />);
    const copy = screen.getByTestId("error-notice-copy");
    expect(copy).toHaveAttribute("aria-label", "复制诊断信息");

    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledTimes(1);
    const diagnostic = writeText.mock.calls[0][0] as string;
    expect(diagnostic).toContain(upstream503.summary);
    expect(diagnostic).toContain("req-unit-503");
    expect(screen.getByTestId("error-notice-copied")).toBeVisible();
  });

  it("用户主动停止：中性（neutral）而非危险红", () => {
    render(<ErrorNotice error={userStopped} />);
    const notice = screen.getByTestId("error-notice");
    expect(notice).toHaveAttribute("data-error-tone", "neutral");
    expect(notice).not.toHaveAttribute("data-error-tone", "danger");
    expect(notice).toHaveAttribute("data-error-code", "user_stopped");
  });

  it("旧字符串错误回落 legacy_error，仍以红卡呈现 summary", () => {
    render(<ErrorNotice text="连接中断：本轮未正常结束，请重试。" />);
    const notice = screen.getByTestId("error-notice");
    expect(notice).toHaveAttribute("data-error-tone", "danger");
    expect(notice).toHaveAttribute("data-error-code", "legacy_error");
    expect(screen.getByTestId("error-notice-summary")).toHaveTextContent("连接中断");
  });

  it("空载荷不渲染错误卡（正常结束的一轮不出现）", () => {
    render(<ErrorNotice error={null} text="" />);
    expect(screen.queryByTestId("error-notice")).not.toBeInTheDocument();
  });
});
