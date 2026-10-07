import type {
  AppSettings,
  ProviderEntry,
  ProviderModel,
  WorkspaceInfo,
} from "@/lib/types";

export function makeModel(name: string, over: Partial<ProviderModel> = {}): ProviderModel {
  return {
    name,
    modalities: null,
    reasoning: null,
    capabilities: null,
    ...over,
  };
}

export function makeProvider(over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id: "p1",
    name: "测试渠道",
    kind: "custom",
    preset_key: null,
    base_url: "https://api.example.com/v1",
    // GET /api/settings 的真实形状：明文不出后端，有 key 时只回掩码（后端 KEY_MASK）
    api_key: "********",
    has_key: true,
    api_format: "openai_chat",
    models: [makeModel("model-a"), makeModel("model-b")],
    created_at: "2026-10-03T00:00:00Z",
    ...over,
  };
}

export function makeSettings(
  providers: ProviderEntry[],
  over: Partial<AppSettings> = {},
): AppSettings {
  return {
    providers,
    active: {
      provider_id: providers[0]?.id ?? "",
      model: providers[0]?.models[0]?.name ?? "",
    },
    system_prompt: "",
    ...over,
  };
}

export function makeWorkspaceInfo(over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    path: "C:/ws/StudyMate",
    source: "默认（~/StudyMate，上游未配置）",
    exists: true,
    subjects_dir: "C:/ws/StudyMate/.learning/subjects",
    config_path: "",
    subject_count: 0,
    candidates: ["C:/ws/StudyMate"],
    ...over,
  };
}
