"""数据域审查回归：会话级工作区全端点、课程 YAML 原子写/事务、坏文件容错。

对应用户拍板：会话绑定工作区时，该会话内的一切科目读写都落在它自己的工作区里
（PRD 会话级工作区一节）；缺省（不传 workspace）保持旧的全局默认行为。
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import yaml

WORKSPACE = Path(os.environ["STUDYMATE_WORKSPACE"])


def _make_workspace(root: Path, name: str, slug: str) -> Path:
    """造一个最小合法工作区：subject + 单节点 curriculum + 空 progress。"""
    workspace = root / name
    subject = workspace / ".learning" / "subjects" / slug
    subject.mkdir(parents=True)
    (subject / "subject.yaml").write_text(
        yaml.safe_dump(
            {
                "name": slug,
                "slug": slug,
                "goal": "工作区隔离回归",
                "created_at": "2026-01-01",
                "status": "进行中",
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    (subject / "curriculum.yaml").write_text(
        yaml.safe_dump(
            {
                "nodes": [
                    {
                        "id": "n1",
                        "title": f"{slug}-节点",
                        "kind": "概念",
                        "objective": "o",
                        "prerequisites": [],
                        "status": "未开始",
                    }
                ],
                "edges": [],
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    (subject / "progress.yaml").write_text(
        yaml.safe_dump(
            {"updated_at": "2026-01-01", "nodes": {}, "misconceptions": [], "project": {"current": ""}},
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return workspace


def _progress(workspace: Path, slug: str) -> dict:
    return yaml.safe_load(
        (workspace / ".learning" / "subjects" / slug / "progress.yaml").read_text(encoding="utf-8")
    )


# ---------------------------------------------------------------- 写端点跟随工作区


def test_progress_write_honors_workspace(client, tmp_path):
    """`PUT .../progress?workspace=` 落在该工作区，不污染默认工作区。"""
    slug = client.post("/api/courses", json={"name": "隔离进度"}).json()["slug"]
    # 默认工作区也放同一节点，验证「带 workspace 不打默认、缺省仍打默认」
    client.put(
        f"/api/courses/{slug}/curriculum",
        json={
            "nodes": [
                {
                    "id": "n1",
                    "title": "t",
                    "kind": "概念",
                    "objective": "o",
                    "prerequisites": [],
                    "status": "未开始",
                }
            ],
            "edges": [],
        },
    )
    other = _make_workspace(tmp_path, "ws-progress", slug)

    response = client.put(
        f"/api/courses/{slug}/nodes/n1/progress",
        json={"status": "学习中"},
        params={"workspace": str(other)},
    )
    assert response.status_code == 200
    assert _progress(other, slug)["nodes"]["n1"]["status"] == "学习中"
    assert _progress(WORKSPACE, slug)["nodes"] == {}

    # 缺省仍写默认工作区（旧行为不变）
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "学习中"}).status_code == 200
    assert _progress(WORKSPACE, slug)["nodes"]["n1"]["status"] == "学习中"


def test_course_crud_honors_workspace(client, tmp_path):
    """POST/curriculum/patch/delete 都能带 `?workspace=`，不落到默认工作区。"""
    other = tmp_path / "ws-crud"
    other.mkdir()  # 绑定点要求目录已存在（backlog #18：尚未支持指向空目录冷启动）
    created = client.post(
        "/api/courses", json={"name": "隔离建课", "slug": "iso-crud"}, params={"workspace": str(other)}
    )
    assert created.status_code == 200
    assert (other / ".learning" / "subjects" / "iso-crud" / "subject.yaml").is_file()
    assert not (WORKSPACE / ".learning" / "subjects" / "iso-crud").exists()

    assert (
        client.put(
            "/api/courses/iso-crud/curriculum",
            json={
                "nodes": [
                    {
                        "id": "n1",
                        "title": "t",
                        "kind": "概念",
                        "objective": "o",
                        "prerequisites": [],
                        "status": "未开始",
                    }
                ],
                "edges": [],
            },
            params={"workspace": str(other)},
        ).status_code
        == 200
    )
    assert client.get("/api/courses/iso-crud", params={"workspace": str(other)}).status_code == 200
    assert client.get("/api/courses/iso-crud").status_code == 404

    assert client.delete("/api/courses/iso-crud", params={"workspace": str(other)}).status_code == 200
    assert not (other / ".learning" / "subjects" / "iso-crud").exists()


def test_misconception_crud_honors_workspace(client, tmp_path):
    slug = client.post("/api/courses", json={"name": "隔离误解"}).json()["slug"]
    other = _make_workspace(tmp_path, "ws-mc", slug)
    payload = {
        "topic": "T",
        "question": "Q",
        "misunderstanding": "U",
        "answer_summary": "A",
    }
    created = client.post(
        f"/api/courses/{slug}/misconceptions", json=payload, params={"workspace": str(other)}
    )
    assert created.status_code == 200
    assert (other / ".learning" / "subjects" / slug / "misconceptions.yaml").is_file()
    assert not (WORKSPACE / ".learning" / "subjects" / slug / "misconceptions.yaml").exists()

    listed = client.get(
        f"/api/courses/{slug}/misconceptions", params={"workspace": str(other)}
    ).json()["items"]
    assert [item["topic"] for item in listed] == ["T"]

    item_id = created.json()["item"]["id"]
    assert (
        client.delete(
            f"/api/courses/{slug}/misconceptions/{item_id}", params={"workspace": str(other)}
        ).status_code
        == 200
    )
    assert (
        client.get(f"/api/courses/{slug}/misconceptions", params={"workspace": str(other)}).json()["items"]
        == []
    )


# ---------------------------------------------------------------- 读端点跟随工作区


def test_read_endpoints_honor_workspace(client, tmp_path):
    """只存在于绑定工作区的科目：lessons/records/quiz 带 ?workspace= 可读，缺省 404。"""
    other = _make_workspace(tmp_path, "ws-read", "iso-read")
    subject = other / ".learning" / "subjects" / "iso-read"
    lessons = subject / "lessons"
    lessons.mkdir()
    (lessons / "0001-n1.html").write_text("<html>lesson</html>", encoding="utf-8")
    (lessons / "0001-n1.quiz.json").write_text(
        json.dumps({"intro": [{"q": "题面", "criteria": "要点"}]}, ensure_ascii=False),
        encoding="utf-8",
    )

    params = {"workspace": str(other)}
    assert client.get("/api/courses/iso-read/lessons", params=params).json()["lessons"][0]["node_id"] == "n1"
    assert client.get("/api/courses/iso-read/records", params=params).status_code == 200
    quiz = client.get("/api/courses/iso-read/quiz/n1", params=params)
    assert quiz.status_code == 200 and quiz.json()["items"][0]["q"] == "题面"
    assert client.get("/api/courses/iso-read/attachments-area", params=params).status_code == 200

    # 缺省落在默认工作区：该科目不存在 → 404，不再静默读到别的科目
    assert client.get("/api/courses/iso-read/lessons").status_code == 404
    assert client.get("/api/courses/iso-read/records").status_code == 404
    assert client.get("/api/courses/iso-read/quiz/n1").status_code == 404


def test_shared_asset_honors_workspace(client, tmp_path):
    other = _make_workspace(tmp_path, "ws-asset", "iso-asset")
    assets = other / ".learning" / "assets"
    assets.mkdir(parents=True)
    (assets / "probe-only-ws.css").write_text("body{}", encoding="utf-8")

    hit = client.get("/api/courses/assets/probe-only-ws.css", params={"workspace": str(other)})
    assert hit.status_code == 200 and hit.text == "body{}"
    # 缺省工作区没有该资源，仓库模板也没有 → 404（不跨工作区串味）
    assert client.get("/api/courses/assets/probe-only-ws.css").status_code == 404


def test_memory_endpoints_honor_workspace(client, tmp_path):
    other = _make_workspace(tmp_path, "ws-mem", "iso-mem")
    entries = [{"section": "教学偏好", "content": "隔离记忆条目"}]

    assert client.post(
        "/api/memory/confirm", json={"entries": entries}, params={"workspace": str(other)}
    ).json()["written"] == 1
    assert "隔离记忆条目" in (other / ".learning" / "MEMORY.md").read_text(encoding="utf-8")
    assert not (WORKSPACE / ".learning" / "MEMORY.md").exists() or "隔离记忆条目" not in (
        WORKSPACE / ".learning" / "MEMORY.md"
    ).read_text(encoding="utf-8")

    body = client.get("/api/memory", params={"workspace": str(other)}).json()
    assert body["exists"] is True and str(other) in body["path"]


def test_memory_confirm_bogus_session_is_rejected(client):
    """会话不存在时不再静默写到全局默认工作区，而是 404。"""
    response = client.post(
        "/api/memory/confirm",
        json={"entries": [{"section": "教学偏好", "content": "x"}], "session_id": "no-such-session"},
    )
    assert response.status_code == 404


def test_assess_and_summary_fall_back_to_workspace_param(client, tmp_path):
    """无会话绑定时，assess/summary 也认 `?workspace=`（不再只能落全局）。"""
    from app import storage

    other = _make_workspace(tmp_path, "ws-assess", "iso-assess")
    session_id = storage.create_session("评估会话", workspace=str(other))["id"]
    storage.update_session(session_id, subject_slug="iso-assess")
    storage.add_message(session_id, "user", "我的作答原文")

    response = client.post(
        "/api/courses/iso-assess/nodes/n1/assess",
        json={},
        params={"workspace": str(other)},
    )
    assert response.status_code == 200
    assert (other / ".learning" / "subjects" / "iso-assess" / response.json()["record_file"]).is_file()
    assert not (WORKSPACE / ".learning" / "subjects" / "iso-assess").exists()


# ---------------------------------------------------------------- 原子写 / 事务 / 容错


def test_progress_transaction_no_lost_update(client, cs):
    """并发读-改-写不同节点：一个都不能丢（无锁实现的典型丢失形态）。"""
    slug = client.post("/api/courses", json={"name": "并发进度"}).json()["slug"]
    total = 12

    def worker(index: int) -> None:
        with cs.progress_transaction(slug) as progress:
            progress.setdefault("nodes", {})[f"n{index}"] = {"status": "学习中", "mastery": 0.1}

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(total)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    nodes = _progress(WORKSPACE, slug)["nodes"]
    assert len(nodes) == total, nodes


def test_concurrent_read_during_write_never_torn(client, cs):
    """一边非原子替换一边读：读侧不允许抛解析错（原实现会 yaml.ScannerError → 500）。"""
    slug = client.post("/api/courses", json={"name": "并发读写"}).json()["slug"]
    big = {
        "nodes": {f"n{i}": {"status": "学习中", "mastery": 0.5, "notes": "x" * 300} for i in range(300)},
        "misconceptions": [],
        "project": {"current": ""},
    }
    errors: list[str] = []
    stop = threading.Event()

    def writer() -> None:
        for _ in range(250):
            if stop.is_set():
                return
            cs.save_progress(slug, dict(big))

    def reader() -> None:
        while not stop.is_set():
            try:
                cs.get_progress(slug)
            except Exception as exc:  # noqa: BLE001 - 这里就是要证明它不会发生
                errors.append(f"{type(exc).__name__}: {exc}")
                return

    readers = [threading.Thread(target=reader) for _ in range(3)]
    for thread in readers:
        thread.start()
    thread = threading.Thread(target=writer)
    thread.start()
    thread.join()
    stop.set()
    for thread in readers:
        thread.join()
    assert errors == [], errors


def test_corrupt_yaml_does_not_break_course_list(client, cs):
    """单个科目的 YAML 坏掉不该让整张科目列表 500（跳过并按缺失处理）。"""
    good_slug = client.post("/api/courses", json={"name": "好科目"}).json()["slug"]
    bad_slug = client.post("/api/courses", json={"name": "坏科目"}).json()["slug"]
    (cs.subject_dir(bad_slug) / "subject.yaml").write_text("name: [未闭合\n", encoding="utf-8")

    listed = client.get("/api/courses")
    assert listed.status_code == 200
    slugs = [item["slug"] for item in listed.json()]
    assert good_slug in slugs and bad_slug not in slugs
    assert client.get(f"/api/courses/{bad_slug}").status_code == 404


def test_token_prefixed_relative_resources_stay_in_workspace(client, tmp_path):
    """HTML→CSS/JS/图片→字体多层相对引用在前缀路由下都留在同一工作区。"""
    from app.routers.workspace_files import encode_workspace_token

    other = _make_workspace(tmp_path, "ws-iframe", "iso-iframe")
    subject = other / ".learning" / "subjects" / "iso-iframe"
    lessons_dir = subject / "lessons"
    lessons_dir.mkdir()
    (lessons_dir / "0001-n1.html").write_text(
        '<link href="../../../assets/probe/theme.css">'
        '<script src="../js/app.js"></script>'
        '<img src="img/pic.png">',
        encoding="utf-8",
    )
    assets = other / ".learning" / "assets" / "probe"
    assets.mkdir(parents=True)
    (assets / "theme.css").write_text("@font-face{src:url(font.woff2)}", encoding="utf-8")
    (assets / "font.woff2").write_bytes(b"\x00\x01binary")
    # 路由 `.../courses/<slug>/files/<path>` 的 `<path>` 相对科目目录：`../js/app.js`
    # 从 lessons/ 上跳一格落到 files/，再落到科目目录下的 js/app.js。
    (subject / "js").mkdir()
    (subject / "js" / "app.js").write_text("//workspace-js", encoding="utf-8")
    (subject / "img").mkdir()
    (subject / "img" / "pic.png").write_bytes(b"\x89PNG-workspace")

    token = encode_workspace_token(other)
    base = f"/api/workspace-files/{token}"

    assert client.get(f"{base}/courses/iso-iframe/files/lessons/0001-n1.html").status_code == 200
    # HTML 里 `../../../assets/probe/theme.css` 的相对解析结果
    assert client.get(f"{base}/courses/assets/probe/theme.css").status_code == 200
    # CSS 里 `url(font.woff2)` 相对 CSS 自身目录的二级解析
    assert client.get(f"{base}/courses/assets/probe/font.woff2").content == b"\x00\x01binary"
    # `../js/app.js` 与 `img/pic.png` 相对 HTML 目录
    assert client.get(f"{base}/courses/iso-iframe/files/js/app.js").text == "//workspace-js"
    assert client.get(f"{base}/courses/iso-iframe/files/img/pic.png").content == b"\x89PNG-workspace"

    # 无前缀的等价 URL 落在默认工作区 → 不应串到 token 工作区的内容
    assert client.get("/api/courses/iso-iframe/files/lessons/0001-n1.html").status_code == 404
    assert client.get("/api/courses/assets/probe/theme.css").status_code == 404
    # containment：前缀路由同样禁止越出科目目录
    assert client.get(f"{base}/courses/iso-iframe/files/%2e%2e/%2e%2e/secret.txt").status_code == 400
    # 坏 token / 不存在的工作区
    assert client.get(f"{base[:-len(token)]}!!!bad/courses/iso-iframe/files/x.html").status_code == 404


def test_token_prefixed_home_relative_resources(client, tmp_path):
    """工作区主页 iframe 的相对资源（`.learning/assets/**`）在前缀路由下按绑定工作区解析。"""
    from app.routers.workspace_files import encode_workspace_token

    other = _make_workspace(tmp_path, "ws-iframe-home", "iso-home")
    (other / "index.html").write_text('<script src=".learning/assets/app.js"></script>', encoding="utf-8")
    assets = other / ".learning" / "assets"
    assets.mkdir(parents=True)
    (assets / "app.js").write_text("//home-js", encoding="utf-8")

    base = f"/api/workspace-files/{encode_workspace_token(other)}"
    assert client.get(f"{base}/home").status_code == 200
    assert client.get(f"{base}/home/.learning/assets/app.js").text == "//home-js"


def test_progress_transition_state_machine(client):
    """TRANSITIONS 唯一实现经路由生效：非法跳转 409，合法逐步 200。"""
    slug = client.post("/api/courses", json={"name": "状态机"}).json()["slug"]
    client.put(
        f"/api/courses/{slug}/curriculum",
        json={
            "nodes": [
                {
                    "id": "n1",
                    "title": "t",
                    "kind": "概念",
                    "objective": "o",
                    "prerequisites": [],
                    "status": "未开始",
                }
            ],
            "edges": [],
        },
    )
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "能独立应用"}).status_code == 409
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "学习中"}).status_code == 200
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "已通过项目验证"}).status_code == 409
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "初步理解"}).status_code == 200
    assert client.put(f"/api/courses/{slug}/nodes/n1/progress", json={"status": "能独立应用"}).status_code == 200
