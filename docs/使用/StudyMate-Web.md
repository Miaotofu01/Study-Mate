# StudyMate Web（独立 Web 运行时）

> **性质**：使用类。怎么把 Web 运行时跑起来、数据落在哪、和插件方式什么关系。
> **状态：尚在开发测试中**，功能可能不如插件途径稳定。
> 功能细节不复述，指针见文末；与上游的边界见[边界与契约](../设计/StudyMate-Web边界与契约.md)。

## 一、它是什么

[`study-mate-web/`](../../study-mate-web/) 是 StudyMate 的**独立 Web 运行时**（FastAPI 后端 + Next.js 16 前端），把课程图谱、掌握度状态机与流式对话搬进浏览器。

它和插件方式**互不依赖**（不装 DSH/Codex 也能跑），但**读写同一套 `.learning` 工作区**——所以同一个工作区可以插件与 Web 交替使用，不需要迁移数据。

## 二、环境要求

- **Python 3.10+**（一键启动脚本按此校验；实测 3.13）
- **Node.js 18+**（实测 24）
- 首次启动需要网络：会自动建 `backend/.venv` 并 `npm install`

## 三、一键启动（推荐）

双击 `study-mate-web/start-web.bat`：

1. 首次运行自动建虚拟环境、装依赖；
2. 比对前端源码时间与上次构建时间，**源码更新过就自动重新构建**（约 1~2 分钟）；
3. 拉起后端 `8101` 与前端 `3800`，就绪后打开浏览器；
4. 启动器窗口自动关闭。

- 服务跑在各自的「StudyMate 后端」「StudyMate 前端」窗口里：**关掉哪个窗口就停哪个服务**；关启动器窗口不影响服务。
- **一键全停**：双击 `stop-web.bat`。它按端口找到监听进程，连同服务窗口与残留孤儿进程一起结束（被任务管理器强杀留下的孤儿也能清掉）。
- 启动前**预检端口**：已被占用时不重复启动，而是报出占用 PID 与处理方式，避免新旧实例重叠、浏览器连到旧实例。
- 可选参数：`start-web.bat dev`（开发模式、热编译、跳过构建）、`restart`（先停再启）、`stop`、`help`。
- 端口可用环境变量覆盖：`SM_WEB_BACKEND_PORT` / `SM_WEB_FRONTEND_PORT`。

## 四、手动启动

后端（端口 8101）：

```bash
cd study-mate-web/backend
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8101
```

前端（端口 3800）：

```bash
cd study-mate-web/frontend
npm install --legacy-peer-deps
npm run dev                 # 开发模式，改动即时生效
# 或生产模式（改完源码必须重新 build，否则伺服的是旧快照）
npm run build && npx next start -p 3800
```

前端通过 Next.js rewrites 把 `/api/*` 同源代理到后端。注意 Next 16 生产构建会把代理目标**固化进构建产物**，`next start` 运行期改 `BACKEND_PORT` 不生效（`next dev` 是运行期读取）。

## 五、数据落在哪

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| Web 自有数据 | `study-mate-web/data/` | settings、sessions、drafts、audit、uploads、exports |
| 学习数据（工作区） | 默认 `~/StudyMate` | 可用 `STUDYMATE_WORKSPACE` / `LEARN_WORKSPACE` / `STUDYMATE_CONFIG` 指定；发现链与插件一致 |
| 附件上传 | `data/uploads/` | 上传 ≤20MB；删会话时连带清理 |

- **不自动种入示例**：工作区里已有的科目与课件原样读取，不迁移、不改写。
- 新对话里可以**按会话绑定工作区**（关联行的「工作区」下拉；空 = 默认工作区），绑定后该会话的科目读写都落在那个工作区。

## 六、首次使用清单

1. **设置 → 提供商**：加一个渠道并填 API Key（`openai_chat` / `openai_responses` / `anthropic` 三种格式）；连接测试在每个模型行的「测试」按钮上。
2. **设置 → 模型**：确认输入模态、最大输出 Token、上下文窗口与推理档位（都没有档位时输入区不显示档位选择器）。
3. **设置 → 工作区**：查看当前发现到的路径，或改选一个；**设置 → 主题**：浅色/暗夜 × 科技蓝/经典墨绿。
4. **新对话**：输入框上方选科目与工作区（都可留空）→ 开始对话；右侧边栏看附件区与会话信息。
5. **课程页**：主区是科目状态与节点详情，右侧边栏在「图谱 / 大纲」之间切换；节点上可申请评估、产出课件。
6. **概念本**：记录与筛选误解条目。

## 七、验证与自测

```bash
# 后端单测（自带隔离运行时）
cd study-mate-web/backend && .venv/Scripts/python.exe -m pytest tests -q

# 旅程级 E2E：Playwright + 后端 fixture，不需要真实 API Key
cd study-mate-web/frontend && npm run test:e2e

# 组件测试（vitest）
cd study-mate-web/frontend && npm run test:component
```

真实模型的冒烟是门控的（`SMOKE_REAL_LLM=1`），默认跳过。测试口径与逐条用例见[E2E 测试流程](../../study-mate-web/StudyMate-Web_E2E测试流程.md)。

## 八、已知限制

- 仅**本机单机**使用：无账号与鉴权，服务只监听 `127.0.0.1`。
- lab 沙箱是子进程级隔离，不是容器级强隔离。
- 真实模型验证只覆盖本机已配置的渠道；`anthropic` / `openai_responses` 的真实流式尚未验证。
- 仍在开发测试中：功能可能不如插件途径稳定。

## 九、指针

| 想了解 | 去哪 |
| --- | --- |
| 与上游的边界、复用了什么、不变量 | [边界与契约](../设计/StudyMate-Web边界与契约.md) |
| 功能现状（做什么） | [子项目 PRD](../../study-mate-web/StudyMate-Web_PRD.md) |
| 架构、契约、队列与 backlog | [开发与计划](../../study-mate-web/StudyMate-Web_开发与计划.md) |
| 用例映射与测试口径 | [E2E 测试流程](../../study-mate-web/StudyMate-Web_E2E测试流程.md) |
| 决策与变更留痕 | [Web_CHANGE](../../study-mate-web/Web_CHANGE.md) |
| 交接索引 | [HANDOFF](../../study-mate-web/HANDOFF.md) |
| 子项目的完整 README（含目录树） | [study-mate-web/README.md](../../study-mate-web/README.md) |
