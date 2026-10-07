"""评估误解落盘：只把「部分通过 / 不通过」的题落成条目，字段指向学生答错的证据。"""
from __future__ import annotations

import yaml


def test_failed_questions_map_to_semantic_fields(new_subject):
    from app import curriculum_store as cs
    from app import misconceptions as mc

    slug, subject_dir = new_subject
    questions = [
        {
            "q": "版本控制要解决的核心问题？",
            "kind": "概念",
            "answer": "旧版本被覆盖找不回",
            "verdict": "不通过",
            "topic": "版本控制的核心问题",
            "note": "只说了回滚，缺「协作与历史」要点",
        },
        {
            "q": "举一个分支协作的例子",
            "kind": "证据核验",
            "answer": "会话中未作答",
            "verdict": "部分通过",
            "topic": "分支协作的具体做法",
            "note": "没举出真实例子",
        },
    ]

    created = mc.add_from_assessment(slug, "git.basics", questions, "复习分支后重估")

    assert [item["topic"] for item in created] == ["版本控制的核心问题", "分支协作的具体做法"]
    first = created[0]
    # 题面 -> question，学生作答原文 -> misunderstanding，判分要点 -> answer_summary
    assert first["question"] == "版本控制要解决的核心问题？"
    assert first["misunderstanding"] == "旧版本被覆盖找不回"
    assert first["answer_summary"] == "只说了回滚，缺「协作与历史」要点"
    assert first["node"] == "git.basics"
    assert first["follow_up"] == "复习分支后重估"
    assert first["importance"] == "medium"
    # 判分注记不得整段塞进 misunderstanding
    assert first["misunderstanding"] != first["answer_summary"]

    # 双落点逐字一致
    on_disk = yaml.safe_load((subject_dir / "misconceptions.yaml").read_text(encoding="utf-8"))
    assert on_disk == cs.get_progress(slug)["misconceptions"]
    assert on_disk == mc.canonical_items(slug)


def test_all_passed_questions_write_nothing(new_subject):
    from app import misconceptions as mc

    slug, subject_dir = new_subject
    questions = [
        {"q": "题一", "answer": "作答一", "verdict": "通过", "topic": "不该落"},
        {"q": "题二", "answer": "作答二", "verdict": "通过"},
    ]

    assert mc.add_from_assessment(slug, "n1", questions, "") == []
    assert mc.list_items(slug) == []
    assert not (subject_dir / "misconceptions.yaml").exists()


def test_topic_falls_back_to_question_text(new_subject):
    from app import misconceptions as mc

    slug, _ = new_subject

    created = mc.add_from_assessment(
        slug,
        "n1",
        [{"q": "什么是快进合并？", "answer": "不知道", "verdict": "不通过", "note": "缺要点"}],
        "",
    )

    assert created[0]["topic"] == "什么是快进合并？"


def test_missing_answer_records_absent_marker(new_subject):
    from app import misconceptions as mc

    slug, _ = new_subject

    created = mc.add_from_assessment(
        slug, "n1", [{"q": "题面", "verdict": "不通过", "topic": "知识点", "note": "缺口"}], ""
    )

    assert created[0]["misunderstanding"] == "会话中未作答"
    assert created[0]["answer_summary"] == "缺口"


def test_duplicate_topic_is_skipped(new_subject):
    from app import misconceptions as mc

    slug, _ = new_subject
    question = [{"q": "题面", "answer": "作答", "verdict": "不通过", "topic": "同一主题", "note": "缺口"}]

    assert len(mc.add_from_assessment(slug, "n1", question, "")) == 1
    assert mc.add_from_assessment(slug, "n1", question, "") == []
    assert len(mc.list_items(slug)) == 1


def test_assess_endpoint_ignores_fabricated_top_level_list(client, cs, new_subject, monkeypatch):
    """回归：落盘只认未通过题自带的 topic，不再采信顶层 misconceptions 自由文本。"""
    from app import misconceptions as mc
    from app import storage
    from app.routers import records as records_router

    slug, _ = new_subject
    client.put(
        f"/api/courses/{slug}/curriculum",
        json={
            "nodes": [
                {"id": "n1", "title": "节点一", "kind": "概念", "objective": "x", "prerequisites": []}
            ],
            "edges": [],
        },
    )
    session_id = client.post("/api/sessions", json={"title": "评估会话"}).json()["id"]
    storage.update_session(session_id, subject_slug=slug, node_id="n1")
    storage.add_message(session_id, "user", "我的作答原文")

    async def fake_chat_once(provider, messages, **kwargs):
        return (
            "---\n"
            'node: n1\n'
            'date: "2026-01-01"\n'
            "questions:\n"
            "  - q: 题面一\n"
            "    answer: 学生的错误作答\n"
            "    verdict: 不通过\n"
            "    topic: 该题真正的误解点\n"
            "    note: 缺要点二\n"
            "verdict: 不通过\n"
            "mastery: 0.3\n"
            "next: 复习后重估\n"
            "misconceptions:\n"
            "  - 跨课程混淆：模型编造的 topic\n"
            "---\n"
        )

    monkeypatch.setattr(records_router, "chat_once", fake_chat_once)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 200

    items = mc.list_items(slug)
    assert len(items) == 1
    item = items[0]
    assert item["topic"] == "该题真正的误解点"
    assert item["question"] == "题面一"
    assert item["misunderstanding"] == "学生的错误作答"
    assert item["answer_summary"] == "缺要点二"
    assert item["node"] == "n1"
