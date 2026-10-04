import fs from "node:fs";
import path from "node:path";

import { E2E_CONFIG_PATH, ensureWorkspaceConfig } from "./constants";

const E2E_API_KEY = "sk-e2e-fixture";
const FIXTURE_SETTINGS = () => {
  const now = Date.now() / 1000;
  const preset = (id: string, name: string, baseUrl: string, model: string) => ({
    id,
    name,
    kind: "preset",
    preset_key: id,
    base_url: baseUrl,
    api_key: "",
    api_format: "openai_chat",
    models: [{ name: model, vision: "auto" }],
    created_at: now,
  });
  return {
    providers: [
      {
        ...preset("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat"),
        api_key: E2E_API_KEY,
      },
      preset("siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"),
      preset("dashscope", "DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
      preset("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"),
    ],
    active: { provider_id: "deepseek", model: "deepseek-chat" },
    // 与后端 PERSONA_PROMPT 一致（config.py，2026-10-03 拍板⑧后的主教练口径）
    system_prompt:
      "你是 StudyMate 自学系统的主教练（学习模式），坚持 learn with doing：讲清概念后引导学习者动手练习，" +
      "用通俗的语言和具体的例子解释知识。开场先按学习者近期状态报告上次学到哪、这次建议学什么；" +
      "每轮回复的最后一行都按「**下一步**：<谁做什么> —— <怎么触发>」的格式给出下一步，别让学生停在那儿等。",
  };
};

function copyYamlOnly(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
      fs.copyFileSync(path.join(source, entry), path.join(target, entry));
    }
  }
}

// examples 课件每个题组至多 1 道选择题，quiz.js 的组计分行（choiceCount > 1 才出现）
// 在真实产物上触发不了；往 e2e 副本注入一个双选择题题组，§3.3 的计分断言才有落点。
const EXTRA_QUIZ_BLOCK =
  `<div class="quiz" data-quiz='[` +
  `{"q":"E2E 追问题一：端到端的可靠传输由哪一层负责？",` +
  `"opts":["传输层","链路层","网络层","应用层"],"ans":0,"why":"可靠传输由传输层的 TCP 负责。"},` +
  `{"q":"E2E 追问题二：IP 地址工作在哪一层？",` +
  `"opts":["网络层","应用层","链路层","传输层"],"ans":0,"why":"IP 地址是网络层地址。"}` +
  `]'></div>`;

function injectScoredQuizGroup(subjectDir: string): void {
  const lessonPath = path.join(subjectDir, "lessons", "0001-net.layers.html");
  const html = fs.readFileSync(lessonPath, "utf-8");
  const marker = '<nav class="lesson-nav"';
  if (!html.includes(marker) || html.includes("E2E 追问题一")) {
    throw new Error(`E2E 计分题组注入点缺失：${lessonPath}`);
  }
  fs.writeFileSync(lessonPath, html.replace(marker, `${EXTRA_QUIZ_BLOCK}\n  ${marker}`));
}

function prepareWorkspace(repoRoot: string): void {
  const studyMateWebDir = path.join(repoRoot, "study-mate-web");
  const backendDir = path.join(studyMateWebDir, "backend");
  const dataDir = path.join(studyMateWebDir, "data");
  const workspaceDir = path.join(dataDir, "e2e-ws");
  const e2eDataDir = path.join(dataDir, "e2e-data");
  const seedDir = path.join(backendDir, "seed");
  const exampleSubjectDir = path.join(
    repoRoot,
    "examples",
    ".learning",
    "subjects",
    "computer-networks",
  );

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(e2eDataDir, { recursive: true, force: true });
  fs.mkdirSync(e2eDataDir, { recursive: true });

  // 与插件 .learning 布局同构（<WS>/.learning/subjects/<slug>）
  const subjectsDir = path.join(workspaceDir, ".learning", "subjects");
  fs.mkdirSync(subjectsDir, { recursive: true });
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyYamlOnly(path.join(seedDir, entry.name), path.join(subjectsDir, entry.name));
    }
  }

  const subjectDir = path.join(subjectsDir, "computer-networks");
  // 术语表也进 e2e 副本：附件区（H④）的「术语表」组才有数据可链
  const glossarySource = path.join(exampleSubjectDir, "GLOSSARY.md");
  if (!fs.existsSync(glossarySource)) {
    throw new Error(`E2E 术语表源缺失：${glossarySource}`);
  }
  fs.copyFileSync(glossarySource, path.join(subjectDir, "GLOSSARY.md"));
  for (const name of ["lessons", "assets"]) {
    const source = path.join(exampleSubjectDir, name);
    if (!fs.existsSync(source)) {
      throw new Error(`E2E 课件源缺失：${source}`);
    }
    fs.cpSync(source, path.join(subjectDir, name), { recursive: true });
  }
  injectScoredQuizGroup(subjectDir);

  // 工作区发现走配置文件（STUDYMATE_CONFIG 指到 e2e-data）：PUT /api/workspace 的可观测切换
  // 才有落点，且不会写进开发者真实的 ~/.dsh
  ensureWorkspaceConfig();

  fs.writeFileSync(
    path.join(e2eDataDir, "settings.json"),
    `${JSON.stringify(FIXTURE_SETTINGS(), null, 2)}\n`,
  );
  if (!fs.existsSync(E2E_CONFIG_PATH)) {
    throw new Error(`E2E 工作区配置未落盘：${E2E_CONFIG_PATH}`);
  }
}

export default function globalSetup(): void {
  prepareWorkspace(path.resolve(__dirname, "../../../.."));
}
