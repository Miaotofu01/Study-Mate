// 探索 agent 的 LLM 客户端（OpenAI 兼容，零依赖 fetch）。
// 端点约定：EXPLORER_LLM_BASE_URL 需含到 /v1 为止（如 https://api.stepfun.com/step_plan/v1）。
// max_tokens 给到 32k：推理模型的 reasoning token 计入 completion_tokens，给小了 content 直接为空
// （实测 2048 踩坑；8192 仍偏保守，两个 step 模型统一 32k）。

import fs from "node:fs";
import path from "node:path";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 读取 tests/explorer/.env（存在时），不覆盖进程已有环境变量 */
function loadEnvFile(): void {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

export function llmConfig(): LlmConfig {
  loadEnvFile();
  const baseUrl = (process.env.EXPLORER_LLM_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.EXPLORER_LLM_API_KEY ?? "";
  const model = process.env.EXPLORER_LLM_MODEL ?? "step-5-preview";
  if (!baseUrl || !apiKey) {
    throw new Error("缺少 EXPLORER_LLM_BASE_URL / EXPLORER_LLM_API_KEY，参考 tests/explorer/.env.example");
  }
  return { baseUrl, apiKey, model };
}

export async function chat(cfg: LlmConfig, messages: unknown[]): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: 32768,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    throw new Error("LLM 返回空 content（reasoning token 可能吃满 max_tokens）");
  }
  return content;
}
