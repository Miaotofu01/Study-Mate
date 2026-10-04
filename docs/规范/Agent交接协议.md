# Agent 交接协议

> **唯一口径**：本文件只定义“角色通过 `.stage/.../deliver/` 把产物交给总控”时的机器交接边界。教学内容、文件 owner 与领域校验仍由各角色 skill 和现有校验器负责。

## 适用范围

角色本来就把产物写到：

```text
<subject_path>/.stage/<角色>-<任务>/deliver/
```

时，必须在同一个 stage 根目录写：

```text
<subject_path>/.stage/<角色>-<任务>/
├── handoff.json
└── deliver/
    └── ...
```

**不为了凑 handoff 改写现有 owner 或落点。** 例如角色规格明确允许直接写正式位置的产物，仍走原 owner、原校验器与原恢复规则；本协议只给已经存在的 staged handoff 加一道机器门禁。

## handoff.json

字段结构以 `<root>/schemas/agent-handoff.schema.json` 为唯一数据契约。

| 字段 | 含义 |
|---|---|
| `schema_version` | 当前固定为 `1` |
| `role` | 三类 staged 角色之一（`resource-scout` / `curriculum-designer` / `practice-evaluator`），必须与总控实际派发角色一致 |
| `subject` | 当前科目 slug |
| `node_id` | 节点级任务写真正节点 id；科目级任务写 `null` |
| `status` | `succeeded` / `blocked` |
| `outputs` | 本轮 `deliver/` 里的产物；路径相对 `deliver/`，`kind` 为 `file` 或 `tree` |
| `checks` | **本角色本轮实际执行过**的机器检查及结果；没有可运行检查时可为 `[]`，不得把没跑的检查写成 `passed` |
| `gaps` | 仍存在但不阻塞交付的缺口；`blocked` 时必须写清阻塞原因 |

只有 `kind: file` 的 output 可以附 `sha256`；有则校验器会按盘上真实字节复算。`kind: tree` 不接受 `sha256`。不要把 `handoff.json` 自己放进 `outputs`。

## 状态语义

- `succeeded`：至少有一个 output；凡写进 `checks` 的检查都必须是 `passed`。可保留**不阻塞交付**的 `gaps`。
- `blocked`：必须在 `gaps` 里写明阻塞原因。可以保留部分产物供排障，但**凡放进 `deliver/` 的文件仍必须由 `outputs` 声明**；不准备声明的 scratch 放在 `deliver/` 之外。总控**不得合盘**。
- 自然语言回复不能覆盖 manifest。角色说“完成了”但 manifest 缺失/非法，按未交接处理。

## outputs 路径

- 一律用 `/`，相对 `deliver/`；禁止绝对路径、Windows drive path、反斜杠、`.`、`..`。
- `kind: file` 指一个普通文件；`kind: tree` 指一个非空目录并递归覆盖其下全部普通文件。
- `deliver/` 中每个普通文件都必须被某个 output 覆盖；多出来的“顺手文件”会阻断合盘。
- manifest、`deliver/`、子目录和文件都不能是符号链接或 Windows 目录联接（junction）。

## 角色交稿

角色先完成自己的领域自检，再最后写 `handoff.json`。这样 manifest 描述的是**已经落盘的最终状态**，不是计划。

典型科目级交付：

```json
{
  "schema_version": 1,
  "role": "curriculum-designer",
  "subject": "linear-algebra",
  "node_id": null,
  "status": "succeeded",
  "outputs": [
    {"path": "curriculum.yaml", "kind": "file"}
  ],
  "checks": [
    {"name": "check_curriculum.py", "status": "passed"}
  ],
  "gaps": []
}
```

节点级交付把 `node_id` 写真实节点 id。

## 总控验收

任何 staged deliver 在合并到正式科目目录之前，先过交接门禁：

```text
DSH：调原生工具 studymate_validate_handoff（参数与返回形状见 .dsh/skills/learning-system/references/tools.md）
无头宿主（Antigravity / Codex）：python3 -B <root>/scripts/check_handoff.py '<stage_dir>' --role '<角色>' [--node '<节点id>']
```

- 放行（工具 `verdict: 'pass'` / 脚本退出 `0`）：只说明**交接边界**合法，可以继续原有的复制、领域校验与档案更新。
- 阻断（工具 `verdict: 'block'` / 脚本退出 `1`）：**不复制、不删 stage、不把任务说成完成**；把原始错误交回同一角色修正，或由总控处理明确的输入/环境缺口。
- 参数错误由调用方报错；先修总控调用，不把它当角色失败。

交接门禁不替代大纲、图片库、课件与内容格式的领域校验（DSH 侧是四个 `studymate_validate_*` 工具，无头侧是 `check_curriculum.py` / `check_pool.py` / `render_lesson.py --check` / `check_lesson.py`）或真实代码测试。前者验证"谁交了什么、盘上是不是那一份"，后者验证"内容本身是否满足领域合同"。
