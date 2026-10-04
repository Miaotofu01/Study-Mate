"""评估联升与学习记录、会话摘要同日追加（阶段 H③/H④）。"""
from __future__ import annotations


def _experiment_curriculum():
    return {
        "nodes": [
            {"id": "c1", "title": "概念一", "kind": "概念", "objective": "x", "prerequisites": []},
            {
                "id": "lab1",
                "title": "实验一",
                "kind": "实验",
                "objective": "y",
                "prerequisites": ["c1"],
            },
        ],
        "edges": [{"from": "c1", "to": "lab1", "reason": "前置"}],
    }


def _assess(client, cs, slug, node_id, mastery):
    from app import storage

    progress = cs.get_progress(slug)
    progress["nodes"] = {
        "lab1": {"status": "能独立应用", "mastery": mastery},
        "c1": {"status": "能独立应用", "mastery": 0.9},
    }
    cs.save_progress(slug, progress)
    session_id = client.post("/api/sessions", json={"title": "评估会话"}).json()["id"]
    storage.update_session(session_id, subject_slug=slug, node_id=node_id)
    storage.add_message(session_id, "user", "我的作答原文")
    return client.post(f"/api/courses/{slug}/nodes/{node_id}/assess", json={"session_id": session_id})


def test_assess_promotes_experiment_with_prerequisites(client, cs, new_subject):
    slug, subject_dir = new_subject
    client.put(f"/api/courses/{slug}/curriculum", json=_experiment_curriculum())

    response = _assess(client, cs, slug, "lab1", mastery=0.8)
    assert response.status_code == 200
    body = response.json()
    assert [item["id"] for item in body["promoted"]] == ["lab1", "c1"]
    assert all(item["status"] == "已通过项目验证" for item in body["promoted"])

    nodes = cs.get_progress(slug)["nodes"]
    assert nodes["lab1"]["status"] == "已通过项目验证"
    assert nodes["c1"]["status"] == "已通过项目验证"
    # 掌握度「保留或上调」：建议 0.4 低于现值 0.8 → 保留；前置无新评估值 → 保留
    assert nodes["lab1"]["mastery"] == 0.8
    assert nodes["c1"]["mastery"] == 0.9

    record = subject_dir / body["learning_record"]
    assert record.is_file()
    assert "实验通过" in record.read_text(encoding="utf-8")
    # 评估产出的误解双落点（fixture canned 的 topic）
    assert (subject_dir / "misconceptions.yaml").is_file()


def test_assess_raises_experiment_mastery_when_suggestion_higher(client, cs, new_subject):
    slug, _ = new_subject
    client.put(f"/api/courses/{slug}/curriculum", json=_experiment_curriculum())

    response = _assess(client, cs, slug, "lab1", mastery=0.2)
    assert response.status_code == 200
    # 建议 0.4 高于现值 0.2 → 上调
    assert cs.get_progress(slug)["nodes"]["lab1"]["mastery"] == 0.4


def test_summary_appends_segments_on_same_day(client, cs, new_subject):
    from app import storage

    slug, subject_dir = new_subject
    session_id = client.post("/api/sessions", json={"title": "小结会话"}).json()["id"]
    storage.update_session(session_id, subject_slug=slug)
    storage.add_message(session_id, "user", "会话内容")

    first = client.post(f"/api/courses/{slug}/sessions/{session_id}/summary", json={})
    second = client.post(f"/api/courses/{slug}/sessions/{session_id}/summary", json={})
    assert first.status_code == second.status_code == 200
    assert first.json()["record_file"] == second.json()["record_file"]

    text = (subject_dir / first.json()["record_file"]).read_text(encoding="utf-8")
    assert text.count("## 本次要点") == 2  # 同日两场各一段，不是覆盖
    assert "## 本场摘要（" in text
    assert text.count("next_step:") == 1  # front matter 只保留首份
