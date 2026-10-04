#!/usr/bin/env python3
"""Regression tests for scripts/check_handoff.py."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / "scripts" / "check_handoff.py"
TMP = Path(tempfile.mkdtemp(prefix="studymate-handoff-"))


def write_stage(name="curriculum-designer-course", *, role="curriculum-designer",
                node=None, status="succeeded", outputs=None, checks=None, gaps=None):
    stage = TMP / name
    deliver = stage / "deliver"
    deliver.mkdir(parents=True)
    file = deliver / "curriculum.yaml"
    file.write_text("nodes: []\nedges: []\n", encoding="utf-8")
    if outputs is None:
        outputs = [{"path": "curriculum.yaml", "kind": "file"}]
    manifest = {
        "schema_version": 1,
        "role": role,
        "subject": "linear-algebra",
        "node_id": node,
        "status": status,
        "outputs": outputs,
        "checks": [{"name": "check_curriculum", "status": "passed"}] if checks is None else checks,
        "gaps": [] if gaps is None else gaps,
    }
    (stage / "handoff.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return stage, manifest


def run(stage, role="curriculum-designer", node=None):
    args = [sys.executable, str(CHECK), str(stage), "--role", role]
    if node is not None:
        args += ["--node", node]
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8")


def check(label, condition, detail=""):
    global bad, total
    total += 1
    if condition:
        print("PASS", label)
    else:
        bad += 1
        print("FAIL", label, detail)


bad = 0
total = 0

try:
    stage, _ = write_stage()
    result = run(stage)
    check("valid manifest passes", result.returncode == 0, result.stderr)

    stage, manifest = write_stage("hash")
    target = stage / "deliver/curriculum.yaml"
    manifest["outputs"][0]["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    check("matching sha256 passes", run(stage).returncode == 0)

    manifest["outputs"][0]["sha256"] = "0" * 64
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = run(stage)
    check("wrong sha256 fails", result.returncode == 1 and "sha256" in result.stderr, result.stderr)

    stage, _ = write_stage("role")
    result = run(stage, role="image-scout")
    check("role mismatch fails", result.returncode == 1 and "角色错配" in result.stderr, result.stderr)

    stage, _ = write_stage("node", role="practice-evaluator", node="vector.space")
    result = run(stage, role="practice-evaluator", node="other.node")
    check("node mismatch fails", result.returncode == 1 and "节点错配" in result.stderr, result.stderr)

    stage, manifest = write_stage("undeclared")
    (stage / "deliver/extra.txt").write_text("extra", encoding="utf-8")
    result = run(stage)
    check("undeclared deliver file fails", result.returncode == 1 and "未声明产物" in result.stderr, result.stderr)

    stage, manifest = write_stage("tree")
    (stage / "deliver/lab/src").mkdir(parents=True)
    (stage / "deliver/lab/src/task.py").write_text("pass\n", encoding="utf-8")
    manifest["outputs"].append({"path": "lab", "kind": "tree"})
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    check("declared tree covers nested descendants", run(stage).returncode == 0)

    manifest["outputs"][-1]["sha256"] = "0" * 64
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = run(stage)
    check("tree sha256 is rejected", result.returncode == 1 and "kind=file" in result.stderr, result.stderr)

    for unsafe in ("../outside.txt", "/absolute.txt", "C:/windows.txt", r"dir\file.txt", "a/./b.txt", "a//b.txt"):
        stage, manifest = write_stage("unsafe-" + str(total))
        manifest["outputs"] = [{"path": unsafe, "kind": "file"}]
        (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
        check(f"unsafe output rejected: {unsafe}", run(stage).returncode == 1)

    stage, manifest = write_stage("failed-check")
    manifest["checks"] = [{"name": "self-test", "status": "not_run"}]
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = run(stage)
    check("succeeded requires passed checks", result.returncode == 1 and "not_run" in result.stderr, result.stderr)

    stage, manifest = write_stage("blocked-partial", status="blocked", checks=[], gaps=["官方站点拒绝访问"])
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    check("blocked may preserve declared partial output", run(stage).returncode == 0)

    stage, manifest = write_stage("blocked-undeclared", status="blocked", outputs=[], checks=[], gaps=["官方站点拒绝访问"])
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = run(stage)
    check("blocked still rejects undeclared deliver file", result.returncode == 1 and "未声明产物" in result.stderr, result.stderr)

    stage, manifest = write_stage("blocked-no-gap", status="blocked", outputs=[], checks=[], gaps=[])
    (stage / "deliver/curriculum.yaml").unlink()
    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = run(stage)
    check("blocked requires gap", result.returncode == 1 and "blocked" in result.stderr, result.stderr)

    stage, _ = write_stage("duplicate-json")
    text = (stage / "handoff.json").read_text(encoding="utf-8")
    text = text.replace('"schema_version": 1,', '"schema_version": 1, "schema_version": 1,', 1)
    (stage / "handoff.json").write_text(text, encoding="utf-8")
    result = run(stage)
    check("duplicate JSON key fails", result.returncode == 1 and "重复 JSON key" in result.stderr, result.stderr)

    if hasattr(Path, "symlink_to"):
        stage, manifest = write_stage("symlink")
        outside = TMP / "outside.txt"
        outside.write_text("secret", encoding="utf-8")
        link = stage / "deliver/link.txt"
        try:
            link.symlink_to(outside)
        except OSError:
            print("SKIP symlink creation unavailable")
        else:
            manifest["outputs"].append({"path": "link.txt", "kind": "file"})
            (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
            result = run(stage)
            check("symlink output fails", result.returncode == 1 and "符号链接" in result.stderr, result.stderr)

    if os.name == "nt":
        import _winapi

        for location in ("deliver", "declared-tree", "undeclared-tree"):
            stage, manifest = write_stage("junction-" + location)
            outside = TMP / ("outside-" + location)
            outside.mkdir()
            (outside / "curriculum.yaml").write_text("outside data", encoding="utf-8")
            if location == "deliver":
                link = stage / "deliver"
                (link / "curriculum.yaml").unlink()
                link.rmdir()
            else:
                link = stage / "deliver" / "linked"
                if location == "declared-tree":
                    manifest["outputs"].append({"path": "linked", "kind": "tree"})
                    (stage / "handoff.json").write_text(json.dumps(manifest), encoding="utf-8")
            _winapi.CreateJunction(str(outside), str(link))
            result = run(stage)
            check(f"junction rejected: {location}",
                  result.returncode == 1 and "目录联接" in result.stderr, result.stderr)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print(f"\n{total - bad}/{total} handoff checks passed")
sys.exit(1 if bad else 0)
