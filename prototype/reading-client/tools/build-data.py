#!/usr/bin/env python3
"""把 examples/ 下的示例学习工作区抽成阅读端原型要的 data/workspace.json。

原型的形状照着「目标态规格」§4（阅读端信息架构）与 §5（学习数据模型）走：
大纲节点 + 三档进度 + 误解记录 + 术语表 + 课件内容文件 + 题库，按科目分组。

与目标态的差别只有一处、且是刻意的：那边由 Host 半监听工作区、按变更通知推给页面，
这里退化成构建期抽一次静态快照，前端 fetch 一次就完事。数据本身是 examples/ 里的真内容，
一个字都没改。

用法：python3 prototype/reading-client/tools/build-data.py
产物：prototype/reading-client/data/workspace.json
      prototype/reading-client/data/lessons/<slug>/<NNNN>-<node>.md（课件内容文件，原样拷贝）
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - 环境缺依赖时给一条能照着做的报错
    sys.exit("需要 PyYAML：pip install pyyaml")

HERE = Path(__file__).resolve()
PROTOTYPE_DIR = HERE.parent.parent              # prototype/reading-client
ROOT = PROTOTYPE_DIR.parent.parent              # 仓库根
SUBJECTS_DIR = ROOT / "examples" / ".learning" / "subjects"
OUT_DIR = PROTOTYPE_DIR / "data"
LESSON_OUT = OUT_DIR / "lessons"

# 三档词表（目标态规格 §5.2）：旧词表读取时自动映射，写回一律用新词表。
TIER_MAP = {
    "未开始": "未开始",
    "学习中": "学习中",
    "初步理解": "学习中",
    "能独立应用": "已学完",
    "需要复习": "已学完",
    "已通过项目验证": "已学完",
}
TIERS = ["未开始", "学习中", "已学完"]


def tint(raw: str | None) -> str:
    """旧词表 → 三档。读到不认识的词就退回「未开始」，不静默当成学会了。"""
    return TIER_MAP.get(raw or "", "未开始")


def read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data or {}


def find_lesson(lessons_dir: Path, node_id: str) -> Path | None:
    """课件文件名是 <序号>-<节点id>.md，节点 id 里带点，按后缀匹配最稳。"""
    if not lessons_dir.is_dir():
        return None
    for path in sorted(lessons_dir.glob("*.md")):
        if path.stem.endswith("-" + node_id):
            return path
    return None


def lesson_number(path: Path | None) -> str:
    if path is None:
        return ""
    match = re.match(r"(\d+)", path.stem)
    return match.group(1) if match else ""


# ── 课件内容文件：只解析出锚点声明，正文原样交给前端 ────────────────────────────
# 正文的块解析（::: quiz / ::: svg / ::: practice / ::: term / ::: resources）在浏览器侧做，
# 与目标态一致：渲染是阅读端的事，Python 侧不再产出 HTML。
ANCHOR_RE = re.compile(r"^:::\s*quiz\s+(\S+)\s+锚点：(.*?)\s*$", re.M)


def lesson_anchors(markdown: str) -> list[dict]:
    return [{"level": m.group(1), "text": m.group(2)} for m in ANCHOR_RE.finditer(markdown)]


def norm(text: str) -> str:
    """规范化只抹掉空白与全角空格——用来区分「逐字一致」与「只差空白」。"""
    return re.sub(r"[\s\u3000]+", "", text)


def resolve_anchors(declared: list[dict], pool: dict[str, list]) -> tuple[list[dict], list[str]]:
    """锚点 ↔ 题库键对账，四态：resolved / stale / ambiguous / missing（目标态规格 §4.4）。

    多匹配绝不静默取第一个：ambiguous 原样报出来，让界面去问人。
    """
    exact = {k.strip(): k for k in pool}
    by_norm: dict[str, list[str]] = {}
    for key in pool:
        by_norm.setdefault(norm(key), []).append(key)

    anchors: list[dict] = []
    used: set[str] = set()
    for item in declared:
        text = item["text"].strip()
        entry = {"text": text, "level": item["level"], "resolution": "missing", "keys": []}
        if text in exact:
            entry["resolution"] = "resolved"
            entry["keys"] = [exact[text]]
        else:
            candidates = by_norm.get(norm(text), [])
            if len(candidates) > 1:
                entry["resolution"] = "ambiguous"
                entry["keys"] = sorted(candidates)
            elif len(candidates) == 1:
                entry["resolution"] = "stale"
                entry["keys"] = candidates
        used.update(entry["keys"])
        anchors.append(entry)

    # 题库里有、正文里没声明的锚点：正文与题库脱钩的另一半，原型也要能看见
    orphan_keys = sorted(k for k in pool if k not in used)
    return anchors, orphan_keys


# ── 附件类文件的解析 ──────────────────────────────────────────────────────────
def parse_glossary(markdown: str) -> list[dict]:
    """GLOSSARY.md 按 `## 分组` + `**词**: 释义` + `_Avoid_: ...` 三段式。"""
    groups: list[dict] = []
    current: dict | None = None
    term: dict | None = None
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            current = {"title": line[3:].strip(), "terms": []}
            groups.append(current)
            term = None
        elif line.startswith("**") and "**:" in line and current is not None:
            name, body = line[2:].split("**:", 1)
            term = {"term": name.strip(), "def": body.strip(), "avoid": ""}
            current["terms"].append(term)
        elif line.startswith("_Avoid_:") and term is not None:
            term["avoid"] = line[len("_Avoid_:"):].strip()
        elif line and term is not None and not term["avoid"]:
            term["def"] = (term["def"] + " " + line.strip()).strip()
    return groups


def parse_mission(markdown: str) -> dict:
    """MISSION.md 是 `## 小节` + 列表；Why 那节是散文，其余是列表。"""
    sections: dict[str, list[str]] = {}
    title: str | None = None
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("# "):
            sections.setdefault("_title", []).append(line[2:].strip())
        elif line.startswith("## "):
            title = line[3:].strip()
            sections.setdefault(title, [])
        elif title and line.strip().startswith("- "):
            sections[title].append(line.strip()[2:].strip())
        elif title and line.strip():
            sections[title].append(line.strip())
    return {"title": (sections.get("_title") or [""])[0], "sections": {k: v for k, v in sections.items() if k != "_title"}}


def read_records(records_dir: Path) -> list[dict]:
    out = []
    if not records_dir.is_dir():
        return out
    for path in sorted(records_dir.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        title = next((l[2:].strip() for l in text.splitlines() if l.startswith("# ")), path.stem)
        date = next((l.split("：", 1)[1].strip() for l in text.splitlines() if l.startswith("- 日期：")), "")
        out.append({"file": path.name, "title": title, "date": date, "markdown": text})
    return out


def read_lab(lab_dir: Path, number: str) -> dict | None:
    """lab 目录按 <序号>-<短名> 命名，序号与课件位次对齐（lab/0003-ip-subnet → 第 3 课）。"""
    if not lab_dir.is_dir() or not number:
        return None
    for child in sorted(lab_dir.iterdir()):
        if child.is_dir() and child.name.startswith(number + "-") and child.name != "solutions":
            files = sorted(p.name for p in child.rglob("*") if p.is_file())
            readme = lab_dir / "README.md"
            return {
                "dir": child.name,
                "files": files,
                "readme": readme.read_text(encoding="utf-8") if readme.is_file() else "",
            }
    return None


# ── 主流程 ────────────────────────────────────────────────────────────────────
def levels_of(nodes: list[dict]) -> dict[str, int]:
    """按前置依赖分层：层号 = 到根的最长路径，路线图按它排。容忍大纲里意外成环。"""
    by_id = {n["id"]: n for n in nodes}
    memo: dict[str, int] = {}

    def depth(node_id: str, seen: frozenset[str]) -> int:
        if node_id in memo:
            return memo[node_id]
        if node_id in seen:
            return 0
        node = by_id.get(node_id)
        if not node:
            return 0
        prereqs = [p for p in (node.get("prerequisites") or []) if p in by_id]
        value = 0 if not prereqs else 1 + max(depth(p, seen | {node_id}) for p in prereqs)
        memo[node_id] = value
        return value

    return {n["id"]: depth(n["id"], frozenset()) for n in nodes}


def build_subject(subject_dir: Path) -> dict:
    subject = read_yaml(subject_dir / "subject.yaml")
    curriculum = read_yaml(subject_dir / "curriculum.yaml")
    progress = read_yaml(subject_dir / "progress.yaml")
    slug = subject.get("slug") or subject_dir.name

    nodes_in = curriculum.get("nodes") or []
    edges = curriculum.get("edges") or []
    progress_nodes = progress.get("nodes") or {}
    levels = levels_of(nodes_in)

    lessons_dir = subject_dir / "lessons"
    (LESSON_OUT / slug).mkdir(parents=True, exist_ok=True)

    nodes = []
    for node in nodes_in:
        node_id = node["id"]
        lesson = find_lesson(lessons_dir, node_id)
        number = lesson_number(lesson)
        markdown = lesson.read_text(encoding="utf-8") if lesson else ""
        pool_path = lesson.with_suffix(".quiz.json") if lesson else None
        pool = json.loads(pool_path.read_text(encoding="utf-8")) if pool_path and pool_path.is_file() else {}
        anchors, orphans = resolve_anchors(lesson_anchors(markdown), pool)

        if lesson:
            shutil.copyfile(lesson, LESSON_OUT / slug / lesson.name)

        run = progress_nodes.get(node_id) or {}
        raw_status = run.get("status") or node.get("status") or "未开始"
        nodes.append({
            "id": node_id,
            "title": node.get("title", node_id),
            "kind": node.get("kind", "概念"),
            "objective": node.get("objective", ""),
            "problem": node.get("problem", ""),
            "concepts": node.get("concepts") or [],
            "pitfalls": node.get("pitfalls") or [],
            "realworld": node.get("realworld", ""),
            "practice": node.get("practice", ""),
            "resources": node.get("resources") or [],
            "prerequisites": node.get("prerequisites") or [],
            "level": levels.get(node_id, 0),
            "tier": tint(raw_status),
            "raw_status": raw_status,
            "notes": run.get("notes", ""),
            "number": number,
            "lesson": f"{slug}/{lesson.name}" if lesson else "",
            "pool": pool,
            "anchors": anchors,
            "orphan_keys": orphans,
            "lab": read_lab(subject_dir / "lab", number),
        })

    stats = {tier: sum(1 for n in nodes if n["tier"] == tier) for tier in TIERS}
    order = {n["id"]: i for i, n in enumerate(nodes)}

    # 「继续学」的候选：先找学习中的，没有就找第一个未开始的，全学完则回到最后一个节点
    current = next((n for n in nodes if n["tier"] == "学习中"), None)
    if current is None:
        current = next((n for n in nodes if n["tier"] == "未开始"), None)
    if current is None and nodes:
        current = nodes[-1]

    return {
        "slug": slug,
        "name": subject.get("name", slug),
        "goal": subject.get("goal", ""),
        "status": subject.get("status", ""),
        "created_at": str(subject.get("created_at", "")),
        "updated_at": str(progress.get("updated_at", "")),
        "project": (progress.get("project") or {}).get("current", ""),
        "mission": parse_mission((subject_dir / "MISSION.md").read_text(encoding="utf-8")
                                 if (subject_dir / "MISSION.md").is_file() else ""),
        "glossary": parse_glossary((subject_dir / "GLOSSARY.md").read_text(encoding="utf-8")
                                   if (subject_dir / "GLOSSARY.md").is_file() else ""),
        "resources_md": (subject_dir / "RESOURCES.md").read_text(encoding="utf-8")
                        if (subject_dir / "RESOURCES.md").is_file() else "",
        "misconceptions": progress.get("misconceptions") or [],
        "misconception_library": read_yaml_list(subject_dir / "misconceptions.yaml"),
        "records": read_records(subject_dir / "learning-records"),
        "nodes": nodes,
        "edges": [{"from": e["from"], "to": e["to"], "reason": e.get("reason", "")} for e in edges],
        "levels": max(levels.values(), default=0) + 1 if levels else 0,
        "stats": stats,
        "continue_node": current["id"] if current else "",
        "order": order,
    }


def read_yaml_list(path: Path) -> list:
    if not path.is_file():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data or []


def main() -> int:
    if not SUBJECTS_DIR.is_dir():
        sys.exit(f"找不到示例工作区：{SUBJECTS_DIR}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if LESSON_OUT.exists():
        shutil.rmtree(LESSON_OUT)

    subjects = [build_subject(d) for d in sorted(SUBJECTS_DIR.iterdir()) if d.is_dir()]
    subjects = [s for s in subjects if s["nodes"]]
    if not subjects:
        sys.exit("示例工作区里没有可用科目")

    updated = sorted(s["updated_at"] for s in subjects if s["updated_at"])
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": str(SUBJECTS_DIR.relative_to(ROOT)),
        "note": "由 tools/build-data.py 从 examples/ 抽出；原型只读，作答不落盘。",
        "today": (updated[-1] if updated else "")[:10],
        "subjects": subjects,
    }
    out = OUT_DIR / "workspace.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    total_nodes = sum(len(s["nodes"]) for s in subjects)
    total_q = sum(len(v) for s in subjects for n in s["nodes"] for v in n["pool"].values())
    resolved = sum(1 for s in subjects for n in s["nodes"] for a in n["anchors"] if a["resolution"] == "resolved")
    anchors = sum(len(n["anchors"]) for s in subjects for n in s["nodes"])
    print(f"写出 {out.relative_to(ROOT)}")
    print(f"  {len(subjects)} 个科目 / {total_nodes} 个节点 / {total_q} 道题 / {anchors} 个锚点")
    print(f"  锚点对账：resolved {resolved}/{anchors}，其余 {anchors - resolved} 个需人工看")
    print(f"  {sum(len(s['records']) for s in subjects)} 条学习记录，"
          f"{sum(len(s['misconceptions']) for s in subjects)} 条误解")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
