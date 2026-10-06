"""pytest 夹具：隔离运行时环境（不外呼 LLM、不碰开发数据）。

env 必须在 import `app.*` 之前就位：`config.DATA_DIR` 与 `llm._fixture_at_import`
都是 import 期求值。`STUDYMATE_WORKSPACE` 固定指向隔离工作区，天然挡住
`PUT /api/workspace` 的真实切换（env 优先级最高），需要测 config 驱动时用
`monkeypatch.delenv` + `workspace.reset_discovery()`。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="studymate-test-"))
WORKSPACE = _TMP / "ws"
DATA_DIR = _TMP / "data"
CONFIG_PATH = _TMP / "dsh" / "studymate-config.yaml"

os.environ["STUDYMATE_WORKSPACE"] = str(WORKSPACE)
os.environ["STUDYMATE_DATA_DIR"] = str(DATA_DIR)
os.environ["STUDYMATE_CONFIG"] = str(CONFIG_PATH)
os.environ["STUDYMATE_E2E_FIXTURE"] = "1"
os.environ.pop("LEARN_WORKSPACE", None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _isolate_settings_file():
    """每个用例前后还原 settings.json：任何用例写坏/改写全局设置都不跨用例污染。

    `load_settings` 几乎被每个请求调用，而设置是整文件读改写；用例若不还原（例如故意
    写坏或替换 providers），后跑的用例会读到被改过的全局配置而失败。此夹具在用例前
    快照原始字节、用例后原样写回（原本不存在则删除），与用例顺序无关。
    """
    from app.config import SETTINGS_PATH

    original = SETTINGS_PATH.read_bytes() if SETTINGS_PATH.exists() else None
    yield
    if original is None:
        SETTINGS_PATH.unlink(missing_ok=True)
    else:
        SETTINGS_PATH.write_bytes(original)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def cs():
    from app import curriculum_store

    return curriculum_store


@pytest.fixture()
def new_subject(client, cs):
    """建一门独立科目，返回 (slug, 科目目录)；每个用例自建，避免相互污染。"""
    counter = getattr(new_subject, "_n", 0) + 1
    new_subject._n = counter  # type: ignore[attr-defined]
    slug = client.post("/api/courses", json={"name": f"测试科目{counter}"}).json()["slug"]
    return slug, cs.subject_dir(slug)
