"""评估输出诊断与受限格式修复：区分解析阶段、最多一次修复、绝不改判。

全部 mock chat_once，不连真实 LLM；数据落在隔离工作区（conftest）。
"""
from __future__ import annotations

import asyncio

import pytest

from app import records as records_svc


VALID = (
    "---\n"
    "node: n1\n"
    'date: "2026-01-01"\n'
    "questions:\n"
    "  - q: 题面一\n"
    "    kind: 概念\n"
    "    answer: 学生的作答原文\n"
    "    verdict: 通过\n"
    "    topic: 核心概念\n"
    "    note: 命中了要点\n"
    "mastery: 0.8\n"
    "verdict: 通过\n"
    "next: 进入下一节点\n"
    "---\n"
)

# 与 VALID 语义等价、仅缺分隔符：可靠取回快照后走一次 LLM 格式修复。
NO_DELIMITERS = (
    "node: n1\n"
    'date: "2026-01-01"\n'
    "questions:\n"
    "  - q: 题面一\n"
    "    kind: 概念\n"
    "    answer: 学生的作答原文\n"
    "    verdict: 通过\n"
    "    topic: 核心概念\n"
    "    note: 命中了要点\n"
    "mastery: 0.8\n"
    "verdict: 通过\n"
    "next: 进入下一节点\n"
)


def _setup(client, cs, slug, node_id="n1"):
    from app import storage

    client.put(
        f"/api/courses/{slug}/curriculum",
        json={
            "nodes": [
                {"id": node_id, "title": "节点一", "kind": "概念", "objective": "x", "prerequisites": []}
            ],
            "edges": [],
        },
    )
    session_id = client.post("/api/sessions", json={"title": "评估会话"}).json()["id"]
    storage.update_session(session_id, subject_slug=slug, node_id=node_id)
    storage.add_message(session_id, "user", "我的作答原文")
    return session_id


def _scripted(outputs):
    calls = []

    async def fake(provider, messages, **kwargs):
        calls.append(messages)
        return outputs[len(calls) - 1]

    return fake, calls


def _progress_status(cs, slug, node_id):
    return (cs.get_progress(slug).get("nodes") or {}).get(node_id) or {}


# ---------- 诊断接口本身 ----------


def test_diagnose_distinguishes_stages():
    missing_lead = records_svc.diagnose_front_matter("node: n1\nverdict: 通过\n")
    assert missing_lead.meta is None and missing_lead.stage == "missing_leading_delimiter"

    missing_tail = records_svc.diagnose_front_matter("---\nnode: n1\n")
    assert missing_tail.meta is None and missing_tail.stage == "missing_trailing_delimiter"

    bad_yaml = records_svc.diagnose_front_matter("---\nnode: n1\n\tverdict: 通过\n---\n")
    assert bad_yaml.meta is None and bad_yaml.stage == "yaml_error"
    assert bad_yaml.line is not None and bad_yaml.column is not None

    not_map = records_svc.diagnose_front_matter("---\n- 一项\n- 二项\n---\n")
    assert not_map.meta is None and not_map.stage == "not_mapping"

    ok = records_svc.diagnose_front_matter(VALID)
    assert ok.meta is not None and ok.stage is None


def test_parse_front_matter_legacy_entry_still_compatible():
    meta, body = records_svc.parse_front_matter(VALID)
    assert meta is not None and meta["verdict"] == "通过"


def test_local_repair_is_mechanical_and_never_guesses():
    repaired = records_svc.repair_front_matter_local("---\nnode: n1\nverdict: 通过\n")
    assert repaired is not None
    assert records_svc.diagnose_front_matter(repaired[0]).meta is not None
    assert "verdict: 通过" in repaired[0]

    # 无法确定时不返回候选，不瞎猜
    assert records_svc.repair_front_matter_local("随便一段文字，没有字段") is None


# ---------- 端点：首次正确 / 本地修复 / LLM 修复 ----------


def test_first_pass_valid_calls_once_and_reports_not_repaired(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    fake, calls = _scripted([VALID])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 200
    body = response.json()
    assert body["format_repaired"] is False
    assert len(calls) == 1
    assert body["assessment"]["verdict"] == "通过"
    assert (subject_dir / body["record_file"]).is_file()
    assert _progress_status(cs, slug, "n1")["status"] == "能独立应用"


def test_local_repair_appends_missing_delimiter_without_llm(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, _ = new_subject
    session_id = _setup(client, cs, slug)
    broken = VALID[: -len("---\n")]  # 有起始 ---，缺结束 ---
    fake, calls = _scripted([broken])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 200
    assert response.json()["format_repaired"] is True
    assert len(calls) == 1  # 本地机械修复，不再调模型


def test_llm_repair_runs_at_most_once_and_succeeds(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, _ = new_subject
    session_id = _setup(client, cs, slug)
    fake, calls = _scripted([NO_DELIMITERS, VALID])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 200
    assert response.json()["format_repaired"] is True
    assert len(calls) == 2
    assert calls[1][0]["content"] == records_router.ASSESS_REPAIR_SYSTEM_PROMPT
    assert "逐字保留" in calls[1][-1]["content"]


def test_repair_still_unparseable_writes_nothing(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    fake, calls = _scripted([NO_DELIMITERS, "还是没有任何字段的一段自由文本"])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    body = response.json()
    assert body["stage"]
    assert body["problems"]
    assert len(calls) == 2
    assert not (subject_dir / "assessments").exists()
    assert not (subject_dir / "misconceptions.yaml").exists()
    assert _progress_status(cs, slug, "n1").get("status") in (None, "未开始")


def test_no_semantic_anchor_refuses_llm_repair(client, cs, new_subject, monkeypatch):
    """首次不可解析且无任何可确定语义锚：不调修复、不落盘，避免无从校验的改判。"""
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    fake, calls = _scripted(["自由发挥的一段话，没有任何字段"])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert len(calls) == 1
    assert not (subject_dir / "assessments").exists()


# ---------- schema 失败不触发修复、不重新判分 ----------


def test_schema_failure_does_not_trigger_repair(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    missing_date = VALID.replace('date: "2026-01-01"\n', "")
    fake, calls = _scripted([missing_date])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    body = response.json()
    assert body["stage"] == "schema"
    assert body["problems"]
    assert len(calls) == 1  # 可解析但 schema 错：不修复、不重新判分
    assert not (subject_dir / "assessments").exists()


# ---------- 修复改判 / 改证据：拒绝保存 ----------


def test_repair_changing_verdict_or_mastery_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    flipped = VALID.replace("verdict: 通过\n", "verdict: 不通过\n").replace(
        "mastery: 0.8", "mastery: 0.2"
    )
    fake, calls = _scripted([NO_DELIMITERS, flipped])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    body = response.json()
    assert body["stage"] == "format_repair"
    assert any("verdict" in problem or "mastery" in problem for problem in body["problems"])
    assert len(calls) == 2
    assert not (subject_dir / "assessments").exists()
    assert not (subject_dir / "misconceptions.yaml").exists()


def test_repair_changing_student_answer_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    tampered = VALID.replace("学生的作答原文", "模型重新编写的作答")
    fake, calls = _scripted([NO_DELIMITERS, tampered])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert response.json()["stage"] == "format_repair"
    assert any("answer" in problem for problem in response.json()["problems"])
    assert not (subject_dir / "assessments").exists()


def test_repair_adding_question_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    extra_question = VALID.replace(
        "    note: 命中了要点\n",
        "    note: 命中了要点\n  - q: 额外题\n    answer: 额外作答\n    verdict: 通过\n",
    )
    fake, _calls = _scripted([NO_DELIMITERS, extra_question])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert response.json()["stage"] == "format_repair"
    assert any("数量" in problem for problem in response.json()["problems"])
    assert not (subject_dir / "assessments").exists()


def test_repair_adding_new_field_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    with_layer = VALID.replace("node: n1\n", "node: n1\nlayer: L2\n")
    fake, _calls = _scripted([NO_DELIMITERS, with_layer])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert any("layer" in problem for problem in response.json()["problems"])
    assert not (subject_dir / "assessments").exists()


def test_repair_changing_node_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    rehomed = VALID.replace("node: n1\n", "node: other-node\n")
    fake, _calls = _scripted([NO_DELIMITERS, rehomed])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert any("node" in problem for problem in response.json()["problems"])
    assert not (subject_dir / "assessments").exists()


def test_repair_changing_topic_or_note_is_rejected(client, cs, new_subject, monkeypatch):
    from app.routers import records as records_router

    for field, old, new in (
        ("topic", "topic: 核心概念\n", "topic: 编造的误解点\n"),
        ("note", "note: 命中了要点\n", "note: 改写的判分注记\n"),
    ):
        slug, subject_dir = new_subject
        session_id = _setup(client, cs, slug)
        tampered = VALID.replace(old, new)
        fake, _calls = _scripted([NO_DELIMITERS, tampered])
        monkeypatch.setattr(records_router, "chat_once", fake)

        response = client.post(
            f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id}
        )
        assert response.status_code == 502, field
        assert any(field in problem for problem in response.json()["problems"]), field
        assert not (subject_dir / "assessments").exists()


def test_unreliable_snapshot_refuses_llm_repair(client, cs, new_subject, monkeypatch):
    """原文含少量可辨认字段但整体无法解析：无法可靠取回快照，保守拒绝。"""
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    broken = "verdict: 通过\nquestions:\n  - q: 题面\n\tverdict: 通过\n"
    fake, calls = _scripted([broken])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert len(calls) == 1  # 不调修复
    assert not (subject_dir / "assessments").exists()


def test_parse_semantic_mapping_refuses_broken_yaml():
    assert records_svc.parse_semantic_mapping("node: n1\n  bad indent: x\n") is None
    assert records_svc.parse_semantic_mapping("node: n1\nnote: |\n  多行值\n") is None
    assert records_svc.parse_semantic_mapping(NO_DELIMITERS) is not None


def _snap(mastery):
    return records_svc.semantic_snapshot(
        {
            "verdict": "通过",
            "node": "n1",
            "date": "2026-01-01",
            "mastery": mastery,
            "questions": [{"q": "题面", "verdict": "通过"}],
        }
    )


def _meta(mastery):
    return {
        "verdict": "通过",
        "node": "n1",
        "date": "2026-01-01",
        "mastery": mastery,
        "questions": [{"q": "题面", "verdict": "通过"}],
    }


def test_bool_and_number_are_not_interchangeable():
    """Python 里 True==1、False==0，但评估语义上 bool 与 number 不得互换。"""
    assert records_svc.verify_snapshot(_snap(True), _meta(1))  # True -> 1 必拒
    assert records_svc.verify_snapshot(_snap(1), _meta(True))  # 1 -> True 必拒
    assert records_svc.verify_snapshot(_snap(0), _meta(False))  # 0 -> False 必拒
    assert records_svc.verify_snapshot(_snap(False), _meta(0))  # False -> 0 必拒
    assert not records_svc.verify_snapshot(_snap(1), _meta(1.0))  # int/float 数值等价放行
    assert not records_svc.verify_snapshot(_snap(0.8), _meta(0.8))


@pytest.mark.parametrize(
    "raw_value,repaired_value",
    [("true", "1"), ("0", "false")],
)
def test_repair_bool_number_conversion_is_rejected(
    client, cs, new_subject, monkeypatch, raw_value, repaired_value
):
    from app.routers import records as records_router

    slug, subject_dir = new_subject
    session_id = _setup(client, cs, slug)
    raw_bool = NO_DELIMITERS.replace("mastery: 0.8", f"mastery: {raw_value}")
    repaired_num = VALID.replace("mastery: 0.8", f"mastery: {repaired_value}")
    fake, _calls = _scripted([raw_bool, repaired_num])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 502
    assert response.json()["stage"] == "format_repair"
    assert any("mastery" in problem for problem in response.json()["problems"])
    assert not (subject_dir / "assessments").exists()



def test_failure_detail_does_not_dump_raw_output(client, cs, new_subject, monkeypatch, caplog):
    from app.routers import records as records_router

    slug, _ = new_subject
    session_id = _setup(client, cs, slug)
    secret = "SECRET-学生隐私-原文"
    fake, _calls = _scripted([f"{secret}，没有任何可解析字段的自由文本"])
    monkeypatch.setattr(records_router, "chat_once", fake)

    with caplog.at_level("WARNING"):
        response = client.post(
            f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id}
        )
    assert response.status_code == 502
    assert secret not in response.text  # 响应不泄原文
    # 诊断日志只记阶段/长度，不回显原文
    assert all(secret not in record.getMessage() for record in caplog.records)
    assert any("stage=" in record.getMessage() for record in caplog.records)


# ---------- 误解 P1 映射仍按逐题 topic 落盘 ----------


def test_misconception_mapping_keeps_per_question_topic(client, cs, new_subject, monkeypatch):
    from app import misconceptions as mc
    from app.routers import records as records_router

    slug, _ = new_subject
    session_id = _setup(client, cs, slug)
    failing = (
        "---\n"
        "node: n1\n"
        'date: "2026-01-01"\n'
        "questions:\n"
        "  - q: 题面一\n"
        "    answer: 学生的错误作答\n"
        "    verdict: 不通过\n"
        "    topic: 该题真正的误解点\n"
        "    note: 缺要点二\n"
        "mastery: 0.3\n"
        "verdict: 不通过\n"
        "next: 复习后重估\n"
        "---\n"
    )
    fake, calls = _scripted([failing])
    monkeypatch.setattr(records_router, "chat_once", fake)

    response = client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})
    assert response.status_code == 200
    assert response.json()["format_repaired"] is False
    assert len(calls) == 1

    items = mc.list_items(slug)
    assert [item["topic"] for item in items] == ["该题真正的误解点"]
    assert items[0]["answer_summary"] == "缺要点二"


# ---------- 取消不被吞 ----------


def test_cancellation_propagates_not_swallowed(client, cs, new_subject, monkeypatch):
    import concurrent.futures

    from app.routers import records as records_router

    slug, _ = new_subject
    session_id = _setup(client, cs, slug)

    async def cancelled(provider, messages, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(records_router, "chat_once", cancelled)

    # 取消必须原样抛出，不得被吞成 502
    with pytest.raises((asyncio.CancelledError, concurrent.futures.CancelledError)):
        client.post(f"/api/courses/{slug}/nodes/n1/assess", json={"session_id": session_id})


def test_repair_call_cancellation_propagates(monkeypatch):
    """修复调用阶段的取消同样不被吞。"""
    from app.routers import records as records_router

    async def cancelled(provider, messages, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(records_router, "chat_once", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            records_router._parse_assessment_with_repair(
                {"model": "x"}, NO_DELIMITERS, "评估输出"
            )
        )
