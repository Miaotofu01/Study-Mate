"""工作区发现、校验与写回（阶段 A）。"""
from __future__ import annotations

import os
from pathlib import Path

import yaml

WORKSPACE = Path(os.environ["STUDYMATE_WORKSPACE"])
CONFIG_PATH = Path(os.environ["STUDYMATE_CONFIG"])


def test_env_overrides_discovery(client):
    body = client.get("/api/workspace").json()
    assert body["path"] == str(WORKSPACE)
    assert body["source"] == "环境变量 STUDYMATE_WORKSPACE"


def test_candidates_include_current_and_default_deduped(client):
    candidates = client.get("/api/workspace").json()["candidates"]
    assert candidates[0] == str(WORKSPACE)
    assert len(candidates) == len(set(candidates))


def test_config_driven_discovery(client, monkeypatch):
    """无 env 覆盖时按配置文件发现（复用上游 learn_workspace()）。"""
    from app import workspace

    monkeypatch.delenv("STUDYMATE_WORKSPACE", raising=False)
    workspace.reset_discovery()
    try:
        client.put("/api/workspace", json={"path": str(WORKSPACE)})
        body = client.get("/api/workspace").json()
        assert body["path"] == str(WORKSPACE)
        assert "studymate-config.yaml" in body["source"]
    finally:
        workspace.reset_discovery()


def test_put_rejects_blank_paths(client):
    before = CONFIG_PATH.read_text(encoding="utf-8") if CONFIG_PATH.exists() else None
    for bad in ("", "   ", "a\nb"):
        assert client.put("/api/workspace", json={"path": bad}).status_code == 422
    after = CONFIG_PATH.read_text(encoding="utf-8") if CONFIG_PATH.exists() else None
    assert after == before


def test_put_quotes_yaml_sensitive_path(client):
    weird = f"{WORKSPACE}/my folder/ws #1"
    assert client.put("/api/workspace", json={"path": weird}).status_code == 200
    raw = CONFIG_PATH.read_text(encoding="utf-8")
    assert "'" in raw  # 含 # 与空格时按 YAML 单引号包裹
    assert yaml.safe_load(raw)["workspace"].endswith("ws #1")


def test_put_rolls_back_when_target_uncreatable(client, monkeypatch):
    from app import workspace

    monkeypatch.delenv("STUDYMATE_WORKSPACE", raising=False)
    workspace.reset_discovery()
    try:
        client.put("/api/workspace", json={"path": str(WORKSPACE)})
        before = CONFIG_PATH.read_text(encoding="utf-8")
        blocker = WORKSPACE.parent / "blocker-file"
        blocker.write_text("x", encoding="utf-8")
        response = client.put("/api/workspace", json={"path": str(blocker / "sub")})
        assert response.status_code == 422
        assert CONFIG_PATH.read_text(encoding="utf-8") == before
    finally:
        workspace.reset_discovery()
