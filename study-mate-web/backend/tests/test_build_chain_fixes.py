"""建课链五处修复的回归测试：

1. 大纲派工值内联 schema 全文 + 硬约束（模型沙箱读不到仓库根 schema）
2. 门禁非零退出但解析不出问题 → 必须判失败（不信任模型自查的延伸）
3. 采图无可抓 URL → 标「跳过（无参考资料）」，UI 不再读成「采图 0 张」
4. 建草稿按科目名去重（同名重复盘问不再建重复草稿）
5. 工单重试走与产课相同的角色工具循环（_role_tool_loop）
"""
from __future__ import annotations

import asyncio

import pytest

from app import draft as draft_svc


@pytest.fixture()
def produce_subject(client, new_subject):
    """带 fixture 大纲（demo.intro/core/lab）的科目，供工单重试用。"""
    from app.llm import FIXTURE_CURRICULUM

    slug, base = new_subject
    r = client.put(f"/api/courses/{slug}/curriculum", json=FIXTURE_CURRICULUM)
    assert r.status_code == 200, r.text
    return slug, base


# ---------- 1. 派工值内联 schema 与硬约束 ----------


def test_curriculum_values_inlines_schema_and_constraints(tmp_path):
    from app import build
    from app.config import SCHEMAS_DIR

    base = tmp_path / "draft"
    base.mkdir()
    values = build.curriculum_values(base, {"name": "示例科目"})

    schema = (SCHEMAS_DIR / "curriculum.schema.json").read_text(encoding="utf-8")
    assert schema in values, "schema 全文必须内联进派工值"
    assert '"realworld"' in schema  # 内联的确实是这份 schema

    # 硬约束逐条在派工值里（模型据此写，不再靠猜）
    assert "^[a-z0-9]+([.-][a-z0-9]+)*$" in values
    assert "不能有大写字母" in values
    assert "id、title、objective、prerequisites、status、kind" in values
    assert "from、to、reason" in values
    assert "realworld 必须是字符串（不是数组）" in values

    # 原有契约句式与资源清单仍在（没有缩短 values 契约）
    assert "节点字段全量以 schemas/curriculum.schema.json 为准" in values
    assert "【资源清单】" in values


# ---------- 2. 门禁：非零退出且解析不出问题 = 失败 ----------


class _FakeProc:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_gate_nonzero_unparseable_is_failure(monkeypatch):
    from app import build
    from app.llm import FIXTURE_CURRICULUM

    monkeypatch.setattr(
        build.subprocess,
        "run",
        lambda *a, **k: _FakeProc(1, "奇怪的输出，没有任何可识别前缀\n", ""),
    )
    problems = asyncio.run(build.run_curriculum_gate(FIXTURE_CURRICULUM))
    assert problems, "非零退出但解析不出问题绝不能判通过"
    assert any("门禁退出码 1" in p["message"] for p in problems)
    assert any("奇怪的输出" in p["message"] for p in problems), "原始输出要回喂给模型"


def test_gate_zero_returncode_still_passes(monkeypatch):
    from app import build
    from app.llm import FIXTURE_CURRICULUM

    monkeypatch.setattr(
        build.subprocess, "run", lambda *a, **k: _FakeProc(0, "  [PASS] schema 校验通过\n", "")
    )
    assert asyncio.run(build.run_curriculum_gate(FIXTURE_CURRICULUM)) == []


def test_gate_nonzero_parseable_keeps_parsed_problems(monkeypatch):
    from app import build
    from app.llm import FIXTURE_CURRICULUM

    monkeypatch.setattr(
        build.subprocess,
        "run",
        lambda *a, **k: _FakeProc(
            1,
            "  [FAIL] 1 个问题：\n    - edges/0: 'reason' is a required property\n",
            "",
        ),
    )
    problems = asyncio.run(build.run_curriculum_gate(FIXTURE_CURRICULUM))
    assert problems and any("reason" in p["message"] for p in problems)
    # 解析成功时不再塞原始输出兜底
    assert all("门禁退出码" not in p["message"] for p in problems)


# ---------- 3. 采图跳过标记 ----------


def _collector():
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    return events, emit


def test_scout_images_marks_skip_when_no_urls(monkeypatch, tmp_path):
    from app import image_scout

    # conftest 在 import 期打开 fixture 模式：这里强制走真实入口（无 URL 不会联网）
    monkeypatch.setattr(image_scout, "is_fixture_mode", lambda: False)
    base = tmp_path / "draft"
    base.mkdir()
    (base / "RESOURCES.md").write_text(
        "# 资源清单\n\n## 延伸阅读\n\n## 官方核对来源\n", encoding="utf-8"
    )
    events, emit = _collector()
    result = asyncio.run(image_scout.scout_images(base, emit))

    assert result["skipped"] is True
    assert result["reason"] == "无参考资料"
    starts = [e for e in events if e.get("event") == "stage" and e.get("status") == "start"]
    dones = [e for e in events if e.get("event") == "stage" and e.get("status") == "done"]
    assert starts and starts[0]["stage"] == "采图 · 跳过（无参考资料）"
    assert dones and dones[0]["stage"] == "采图 · 跳过（无参考资料）"
    assert dones[0]["skipped"] is True and dones[0]["reason"] == "无参考资料"


def test_scout_images_plain_stage_when_urls_present(monkeypatch, tmp_path):
    from app import image_scout

    monkeypatch.setattr(image_scout, "is_fixture_mode", lambda: False)
    base = tmp_path / "draft"
    base.mkdir()
    # 回环地址：SSRF 校验直接拒绝，不会真的发请求；只为证明有 URL 时不标跳过
    (base / "RESOURCES.md").write_text(
        "# 资源清单\n\n- http://127.0.0.1:9/none\n", encoding="utf-8"
    )
    events, emit = _collector()
    result = asyncio.run(image_scout.scout_images(base, emit))

    assert "skipped" not in result
    dones = [e for e in events if e.get("event") == "stage" and e.get("status") == "done"]
    assert dones and dones[0]["stage"] == "采图"
    assert "skipped" not in dones[0]


# ---------- 4. 草稿同名去重 ----------


def test_create_draft_reuses_same_name():
    first = draft_svc.create_draft("去重科目-Zeta", slug="dedup-zeta-1")
    try:
        # 大小写不同 + 首尾空白不同，仍认作同一门课
        second = draft_svc.create_draft("  去重科目-zeta  ", slug="dedup-zeta-2")
        assert second == first
        assert not draft_svc.draft_dir("dedup-zeta-2").exists()
        names = [d["name"] for d in draft_svc.list_drafts()]
        assert names.count("去重科目-Zeta") == 1
    finally:
        draft_svc.delete_draft(first)


def test_create_draft_slug_collision_with_other_name_still_raises():
    first = draft_svc.create_draft("冲突科目-甲", slug="collide-slug-1")
    try:
        with pytest.raises(FileExistsError):
            draft_svc.create_draft("冲突科目-乙", slug="collide-slug-1")
    finally:
        draft_svc.delete_draft(first)


# ---------- 5. 工单重试走角色工具循环 ----------


def test_ticket_retry_uses_role_tool_loop(monkeypatch, client, produce_subject):
    from app import llm
    from app import produce as produce_svc
    from app.routers import production
    from app import tickets as tickets_svc

    slug, _base = produce_subject
    # 先按 fixture 跑一遍，落好课件与题库，制造可复检的科目状态
    client.post(f"/api/courses/{slug}/nodes/demo.intro/produce", json={})

    # 切到真实派工模式：fixture 短路关掉，provider 有值（supports_tools 默认开）
    monkeypatch.delenv("STUDYMATE_E2E_FIXTURE", raising=False)
    monkeypatch.setattr(llm, "_fixture_at_import", False)
    monkeypatch.setattr(
        production, "require_provider", lambda *a, **k: {"model": "test", "api_format": "openai_chat"}
    )

    entered: list[str] = []

    async def fake_loop(provider, route, values, emit, *, base, node_id, index, stage_dir):
        entered.append(route)
        if route == "produce_experiment":
            return produce_svc.fixture_experiment_envelope(values)
        if route == "produce_quiz":
            return produce_svc.fixture_quiz_envelope(values)
        return produce_svc.fixture_content_envelope(values)

    monkeypatch.setattr(produce_svc, "_role_tool_loop", fake_loop)

    ticket = tickets_svc.create_ticket(
        kind="produce",
        slug=slug,
        node_id="demo.intro",
        base_label="workspace",
        problems=[
            {
                "owner": "出题",
                "path": "lessons/0001-demo.intro.quiz.json",
                "line": "",
                "message": "示例问题",
            }
        ],
        artifacts=["lessons/0001-demo.intro.quiz.json"],
    )
    r = client.post(f"/api/tickets/{ticket['id']}/retry", json={})
    names = [name for name, _ in _sse(r)]
    assert entered, "工单重试必须进入共享的角色工具循环（_role_tool_loop）"
    assert entered[0] == "produce_quiz"
    assert "done" in names
    assert tickets_svc.get_ticket(ticket["id"])["status"] == "已解决"


def _sse(r):
    import json

    out = []
    current = None
    for line in r.text.splitlines():
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current is not None:
            out.append((current, json.loads(line[6:])))
            current = None
    return out
