import fs from "node:fs";
import path from "node:path";

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
    system_prompt: "你是 StudyMate，一个陪伴式学习助手。",
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

  const subjectsDir = path.join(workspaceDir, "subjects");
  fs.mkdirSync(subjectsDir, { recursive: true });
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyYamlOnly(path.join(seedDir, entry.name), path.join(subjectsDir, entry.name));
    }
  }

  const subjectDir = path.join(subjectsDir, "computer-networks");
  for (const name of ["lessons", "assets"]) {
    const source = path.join(exampleSubjectDir, name);
    if (!fs.existsSync(source)) {
      throw new Error(`E2E 课件源缺失：${source}`);
    }
    fs.cpSync(source, path.join(subjectDir, name), { recursive: true });
  }
  injectScoredQuizGroup(subjectDir);

  fs.writeFileSync(
    path.join(e2eDataDir, "settings.json"),
    `${JSON.stringify(FIXTURE_SETTINGS(), null, 2)}\n`,
  );
}

export default function globalSetup(): void {
  prepareWorkspace(path.resolve(__dirname, "../../../.."));
}
