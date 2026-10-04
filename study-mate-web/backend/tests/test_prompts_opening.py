"""提示词分层与开场状态切片（阶段 B / H①）。"""
from __future__ import annotations

import yaml


def test_skill_routes_inject_full_text_and_adaptation():
    """拍板⑧后的路由口径：chat=local-qa；interview=learning-system+learning-discovery+收口标记。"""
    from app import prompts

    text, missing = prompts.inject("chat")
    assert missing == []
    assert "local-qa" in text
    assert "运行环境适配" in text  # Web 场景适配说明随注入
    # 全文注入：local-qa 的关键结构直接来自 SKILL.md
    assert "局部提问" in text

    interview_text, missing = prompts.inject_interview()
    assert missing == []
    # learning-system 全文注入：关键结构直接来自 SKILL.md
    assert "会话开场" in interview_text and "对话节奏" in interview_text
    assert '<skill name="learning-discovery">' in interview_text
    assert "INTERVIEW_RESULT" in interview_text  # 建课收口标记口径


def test_skill_missing_reports_names(monkeypatch, tmp_path):
    from app import prompts

    monkeypatch.setattr(prompts, "SKILLS_DIR", tmp_path)
    monkeypatch.setattr(prompts, "_cache", {})
    text, missing = prompts.inject("chat")
    assert text == ""
    assert missing == ["local-qa"]


def test_chat_stream_503_without_skills_leaves_no_message(client, monkeypatch, tmp_path):
    from app import prompts

    before = len(client.get("/api/sessions").json())
    monkeypatch.setattr(prompts, "SKILLS_DIR", tmp_path)
    monkeypatch.setattr(prompts, "_cache", {})
    try:
        response = client.post("/api/chat/stream", json={"message": "你好"})
        assert response.status_code == 503
        assert len(client.get("/api/sessions").json()) == before  # 未建会话、未落消息
    finally:
        monkeypatch.undo()


def test_opening_slice_covers_memory_misconceptions_records(client, cs, new_subject):
    from app import memory as memory_svc
    from app import records as records_svc
    from app.routers.chat import _opening_slice

    slug, subject_dir = new_subject
    (subject_dir).mkdir(parents=True, exist_ok=True)

    # 共享记忆
    (cs.workspace_dir() / ".learning").mkdir(parents=True, exist_ok=True)
    (cs.workspace_dir() / ".learning" / "MEMORY.md").write_text(
        "# 学习者记忆\n\n## 教学偏好\n\n- 喜欢先看例子\n", encoding="utf-8"
    )
    # 误解（canonical 文件）
    (subject_dir / "misconceptions.yaml").write_text(
        yaml.safe_dump(
            [
                {"id": "aaaa1111", "topic": "误解B", "misunderstanding": "m2", "answer_summary": "a2"},
                {"id": "bbbb2222", "topic": "误解A", "misunderstanding": "m1", "answer_summary": "a1"},
            ],
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    # 学习记录 + 评估记录
    records_svc.write_learning_record(slug, "n1", "节点一", "评估通过", "assessments/001-n1.md")
    (subject_dir / "assessments").mkdir(exist_ok=True)
    (subject_dir / "assessments" / "001-n1.md").write_text(
        '---\nnode: n1\ndate: "2026-01-01"\nverdict: 通过\n---\n正文\n', encoding="utf-8"
    )

    text = _opening_slice(slug) or ""
    assert "【共享记忆】" in text and "喜欢先看例子" in text
    assert "【最近误解】" in text and "误解A" in text
    assert "【最近学习记录】" in text and "learning-records/" in text
    assert "【最近评估】" in text and "n1" in text


def test_opening_slice_prefers_canonical_misconceptions(client, cs, new_subject):
    """misconceptions.yaml 存在时以它为准（progress 侧陈旧也不漏）。"""
    from app.routers.chat import _opening_slice

    slug, subject_dir = new_subject
    progress = cs.get_progress(slug)
    progress["misconceptions"] = []
    cs.save_progress(slug, progress)
    subject_dir.mkdir(parents=True, exist_ok=True)
    (subject_dir / "misconceptions.yaml").write_text(
        yaml.safe_dump(
            [{"id": "cccc3333", "topic": "只写在 yaml 的误解", "misunderstanding": "m", "answer_summary": "a"}],
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    assert "只写在 yaml 的误解" in (_opening_slice(slug) or "")
