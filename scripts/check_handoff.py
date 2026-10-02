#!/usr/bin/env python3
"""Validate one subagent stage handoff before the controller merges deliver/.

Usage:
  python3 scripts/check_handoff.py <stage_dir> --role <role> [--node <node_id>]

The stage directory must contain:
  handoff.json
  deliver/

The validator checks the JSON schema plus filesystem invariants that JSON Schema
cannot express: safe relative paths, symlink rejection, declared outputs actually
existing, optional SHA-256 matches, and complete coverage of deliver/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "agent-handoff.schema.json"
HANDOFF = "handoff.json"
DELIVER = "deliver"
DRIVE_RE = re.compile(r"^[A-Za-z]:")


class HandoffError(ValueError):
    """Invalid handoff manifest or unsafe staged output."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise HandoffError(f"重复 JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle, object_pairs_hook=unique_object)


def validate_schema(value, schema, path="<root>"):
    """Validate the small Draft-07 subset used by agent-handoff.schema.json.

    Keeping this local avoids making jsonschema a new hard dependency of npm test /
    DSH while the schema file remains the single field contract.
    """
    if "const" in schema and value != schema["const"]:
        raise HandoffError(f"{path}: 必须等于 {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise HandoffError(f"{path}: 不在允许值 {schema['enum']!r} 中")

    expected = schema.get("type")
    if expected is not None:
        allowed = expected if isinstance(expected, list) else [expected]
        type_ok = False
        for kind in allowed:
            if kind == "object" and isinstance(value, dict):
                type_ok = True
            elif kind == "array" and isinstance(value, list):
                type_ok = True
            elif kind == "string" and isinstance(value, str):
                type_ok = True
            elif kind == "null" and value is None:
                type_ok = True
        if not type_ok:
            raise HandoffError(f"{path}: 类型应为 {allowed!r}")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise HandoffError(f"{path}: 字符串太短")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise HandoffError(f"{path}: 字符串太长")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise HandoffError(f"{path}: 不匹配要求的格式")

    if isinstance(value, dict):
        required = schema.get("required", [])
        missing = [key for key in required if key not in value]
        if missing:
            raise HandoffError(f"{path}: 缺少字段 {missing!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(properties))
            if extra:
                raise HandoffError(f"{path}: 不允许额外字段 {extra!r}")
        for key, child in value.items():
            child_schema = properties.get(key)
            if child_schema is not None:
                validate_schema(child, child_schema, f"{path}/{key}")

    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            validate_schema(item, schema["items"], f"{path}/{index}")


def inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def safe_relative(value: str) -> PurePosixPath:
    if "\\" in value:
        raise HandoffError(f"output.path 必须用 /，不能含反斜杠: {value}")
    if value.startswith("/") or DRIVE_RE.match(value):
        raise HandoffError(f"output.path 必须是 deliver/ 下的相对路径: {value}")
    parts = value.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise HandoffError(f"output.path 不能含空段、. 或 ..: {value}")
    return PurePosixPath(*parts)


def reject_symlink(path: Path, label: str):
    try:
        stat = path.lstat()
    except FileNotFoundError:
        raise HandoffError(f"{label} 不存在: {path}") from None
    if path.is_symlink():
        raise HandoffError(f"{label} 不能是符号链接: {path}")
    return stat


def iter_regular_files(root: Path):
    if not root.exists():
        return
    for directory, dirs, files in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        reject_symlink(directory_path, "deliver 目录")
        for name in list(dirs):
            reject_symlink(directory_path / name, "deliver 子目录")
        for name in files:
            file = directory_path / name
            reject_symlink(file, "deliver 文件")
            if not file.is_file():
                raise HandoffError(f"deliver 里只允许普通文件/目录: {file}")
            yield file


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate(stage: Path, expected_role: str, expected_node: str | None) -> dict:
    stage = stage.resolve(strict=True)
    if not stage.is_dir():
        raise HandoffError("stage_dir 必须是目录")

    manifest_path = stage / HANDOFF
    deliver = stage / DELIVER
    reject_symlink(manifest_path, HANDOFF)
    reject_symlink(deliver, DELIVER)
    if not manifest_path.is_file() or not deliver.is_dir():
        raise HandoffError("stage_dir 必须同时包含 handoff.json 与 deliver/")

    data = load_json(manifest_path)
    schema = load_json(SCHEMA_PATH)
    try:
        validate_schema(data, schema)
    except HandoffError as error:
        raise HandoffError("schema 校验失败：" + str(error)) from error

    if data["role"] != expected_role:
        raise HandoffError(f"角色错配：manifest={data['role']}，expected={expected_role}")
    if expected_node is None:
        if data["node_id"] is not None:
            raise HandoffError(f"科目级任务 node_id 必须是 null，实际为 {data['node_id']!r}")
    elif data["node_id"] != expected_node:
        raise HandoffError(f"节点错配：manifest={data['node_id']!r}，expected={expected_node!r}")

    outputs = data["outputs"]
    if data["status"] == "succeeded":
        if not outputs:
            raise HandoffError("succeeded 必须声明至少一个 output")
        bad = [item["name"] for item in data["checks"] if item["status"] != "passed"]
        if bad:
            raise HandoffError("succeeded 不能包含 failed/not_run check：" + "、".join(bad))
    elif not data["gaps"]:
        raise HandoffError("blocked 必须在 gaps 里写明阻塞原因")

    declared_files = set()
    declared_roots = []
    seen_paths = set()
    for output in outputs:
        rel = safe_relative(output["path"])
        rel_text = rel.as_posix()
        if rel_text in seen_paths:
            raise HandoffError(f"outputs 重复声明路径: {rel_text}")
        seen_paths.add(rel_text)

        target = deliver.joinpath(*rel.parts)
        reject_symlink(target, "output")
        resolved = target.resolve(strict=True)
        if not inside(resolved, deliver.resolve()):
            raise HandoffError(f"output 逃出 deliver/: {rel_text}")

        if output["kind"] == "file":
            if not resolved.is_file():
                raise HandoffError(f"kind=file 但不是普通文件: {rel_text}")
            declared_files.add(rel_text)
            if "sha256" in output:
                actual = sha256(resolved)
                if actual != output["sha256"]:
                    raise HandoffError(f"sha256 不匹配: {rel_text}")
        else:
            if "sha256" in output:
                raise HandoffError(f"sha256 仅支持 kind=file: {rel_text}")
            if not resolved.is_dir():
                raise HandoffError(f"kind=tree 但不是目录: {rel_text}")
            files = list(iter_regular_files(resolved))
            if not files:
                raise HandoffError(f"kind=tree 不能声明空目录: {rel_text}")
            declared_roots.append(rel_text.rstrip("/") + "/")

    actual_files = {
        file.relative_to(deliver).as_posix()
        for file in iter_regular_files(deliver)
    }
    covered = {
        path for path in actual_files
        if path in declared_files or any(path.startswith(root) for root in declared_roots)
    }
    undeclared = sorted(actual_files - covered)
    if undeclared:
        raise HandoffError("deliver/ 有未声明产物：" + "、".join(undeclared[:8])
                           + ("…" if len(undeclared) > 8 else ""))

    return data


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage_dir")
    parser.add_argument("--role", required=True)
    parser.add_argument("--node")
    args = parser.parse_args(argv)
    try:
        data = validate(Path(args.stage_dir), args.role, args.node)
    except (HandoffError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"FAIL {args.stage_dir}: {error}", file=sys.stderr)
        return 1
    print(f"OK   {args.stage_dir}/handoff.json ({data['role']}, {len(data['outputs'])} outputs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
