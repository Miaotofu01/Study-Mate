"""采图（image-scout 等价物，§5.1 E 行）：纯后端爬虫，不进 LLM 角色体系。

沿 RESOURCES.md 的链接抓网页里现成的位图，配额与过滤照搬插件规格：
每站最多 8 个页面 / 6 张图（按站点累计）、同站 ≤1 请求/秒、尊重 robots、
不抓 PDF 与动态加载；过滤图标/头像/装饰/广告、宽 <400px、单张 >500KB。
命名与索引（assets/img/pool.md 七列 + ## Gaps）照搬，`scripts/check_pool.py`
自检，图片库为空不阻塞建课。

安全边界：只允许 http/https；每次请求前解析主机并拒绝私网/回环/链路本地
地址（SSRF 收敛）；重定向手动逐跳校验；页面（入口与下钻）只走清单点名的
站点，图片必须是页面上的现成位图。
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import struct
import subprocess
import sys
import time
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx

from .config import SCRIPTS_DIR
from .llm import is_fixture_mode

PAGES_PER_SITE = 8
IMAGES_PER_SITE = 6
REQUEST_INTERVAL_SECONDS = 1.0
MAX_REDIRECTS = 3
MIN_WIDTH = 400
MAX_BYTES = 500 * 1024
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
POOL_DIR_REL = "assets/img/pool"
POOL_INDEX_REL = "assets/img/pool.md"
INDEX_HEADER = "| 文件 | 主题标签 | 一句话说明 | 来源 URL | 许可 | 尺寸 | 抓取日期 |"

_SKIP_HINTS = (
    "logo", "icon", "avatar", "sprite", "banner", "watermark", "ads", "advert",
    "emoji", "badge", "button", "favicon", "placeholder", "loading", "spacer",
)
_URL_RE = re.compile(r"https?://[^\s)\]>\"]+", re.IGNORECASE)
_NAME_CHARS_RE = re.compile(r"[^0-9A-Za-z\u4e00-\u9fa5-]+")
_LINK_DEPTH_LIMIT = 2  # 入口页 → 下钻页最多两跳（与 image-scout 规格一致）


class _ImgCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.images: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "img":
            return
        self.images.append({key.lower(): (value or "") for key, value in attrs})


def _site_of(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def _site_base(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme or 'https'}://{parsed.netloc}"


def extract_resource_urls(resources_text: str) -> list[str]:
    """RESOURCES.md 里出现过的 URL（保序去重）。"""
    seen: list[str] = []
    for match in _URL_RE.findall(resources_text or ""):
        url = match.rstrip(".,;、")
        if url not in seen:
            seen.append(url)
    return seen


def _sanitize_segment(text: str, max_len: int = 20) -> str:
    cleaned = _NAME_CHARS_RE.sub("-", (text or "").strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned[:max_len].strip("-")


def _glossary_topics(base: Path) -> list[str]:
    path = base / "GLOSSARY.md"
    topics: list[str] = []
    if path.is_file():
        in_section = False
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("## "):
                in_section = line.strip() in ("## 待掌握", "## 已掌握")
                continue
            if in_section and line.strip().startswith("- "):
                topics.append(line.strip()[2:].strip())
    return topics


def _pick_topic(base: Path, used: set[str]) -> str:
    """主题从术语表挑（逐字照用）；都用过就复用第一个，保证命名合法。"""
    for topic in _glossary_topics(base):
        segment = _sanitize_segment(topic, 16)
        if segment and segment not in used:
            used.add(segment)
            return segment
    fallback = _sanitize_segment(_subject_name(base), 16) or "配图"
    return fallback


def _subject_name(base: Path) -> str:
    subject = base / "subject.yaml"
    if subject.is_file():
        match = re.search(r"^name:\s*(.+)$", subject.read_text(encoding="utf-8"), re.MULTILINE)
        if match:
            return match.group(1).strip()
    return base.name


def _image_dimensions(data: bytes, ext: str) -> tuple[int, int] | None:
    """从文件头读宽高（不装图像库）；读不出返回 None。"""
    try:
        if ext == ".png" and len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
            width, height = struct.unpack(">II", data[16:24])
            return int(width), int(height)
        if ext == ".gif" and len(data) >= 10 and data[:4] == b"GIF8":
            width, height = struct.unpack("<HH", data[6:10])
            return int(width), int(height)
        if ext in (".jpg", ".jpeg") and data[:2] == b"\xff\xd8":
            offset = 2
            while offset + 9 < len(data):
                if data[offset] != 0xFF:
                    offset += 1
                    continue
                marker = data[offset + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                    height, width = struct.unpack(">HH", data[offset + 5 : offset + 9])
                    return int(width), int(height)
                seg_len = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
                offset += 2 + seg_len
    except (struct.error, IndexError):
        return None
    return None


def _looks_decorative(info: dict[str, str], filename: str) -> bool:
    haystack = " ".join(
        [info.get("class", ""), info.get("id", ""), info.get("alt", ""), filename]
    ).lower()
    return any(hint in haystack for hint in _SKIP_HINTS)


def _attr_width(info: dict[str, str]) -> int | None:
    raw = info.get("width") or ""
    match = re.match(r"^(\d+)", raw.strip())
    return int(match.group(1)) if match else None


def _assert_public_url(url: str) -> None:
    """SSRF 收敛：只允许 http/https，主机解析后拒绝私网/回环/链路本地/保留地址。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"只允许 http/https：{url}")
    host = parsed.hostname or ""
    if not host:
        raise ValueError(f"URL 缺主机名：{url}")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError(f"主机解析失败：{host}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise ValueError(f"主机解析到非公网地址，拒绝请求：{host} → {address}")


class _Throttle:
    """同站 ≤1 请求/秒：每次 GET 前调用，必要时睡到间隔满足。"""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}

    async def wait(self, site: str) -> None:
        previous = self._last.get(site)
        if previous is not None:
            elapsed = time.monotonic() - previous
            if elapsed < REQUEST_INTERVAL_SECONDS:
                await asyncio.sleep(REQUEST_INTERVAL_SECONDS - elapsed)
        self._last[site] = time.monotonic()


async def _get_with_redirects(
    client: httpx.AsyncClient,
    url: str,
    throttle: _Throttle,
    site: str,
) -> httpx.Response:
    """手动逐跳跟随重定向（≤3 跳），每一跳都过限速与 SSRF 校验。"""
    current = url
    response = None
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(current)
        await throttle.wait(site)
        response = await client.get(current)
        if response.is_redirect:
            location = response.headers.get("location")
            if not location:
                return response
            current = urljoin(current, location)
            continue
        return response
    return response


async def _allowed(
    client: httpx.AsyncClient,
    page_url: str,
    robots_cache: dict[str, RobotFileParser | None],
    throttle: _Throttle,
) -> bool:
    site = _site_of(page_url)
    if site in robots_cache:
        parser = robots_cache[site]
        return parser is None or parser.can_fetch("*", page_url)
    parser: RobotFileParser | None = RobotFileParser()
    try:
        robots_url = f"{_site_base(page_url)}/robots.txt"
        _assert_public_url(robots_url)
        await throttle.wait(site)
        response = await client.get(robots_url)
        if response.status_code >= 400 or response.is_redirect:
            parser = None  # robots 拿不到就当允许（与"抓不动就跳过"同级的现实处理）
        else:
            parser.parse(response.text.splitlines())
    except (httpx.HTTPError, ValueError):
        parser = None
    robots_cache[site] = parser
    return parser is None or parser.can_fetch("*", page_url)


def _new_row(
    filename: str,
    topic: str,
    description: str,
    page_url: str,
    license_note: str,
    size: tuple[int, int],
) -> str:
    width, height = size
    return (
        f"| {filename} | {topic} | {description} | {page_url} | {license_note} "
        f"| {width}×{height} | {date.today().isoformat()} |"
    )


def _build_filename(
    topic: str, subtopic: str, point: str, site_abbr: str, serial: int, ext: str
) -> str:
    """`<主题>-<子主题>-<要点>-<来源缩写>-<NN>.<ext>`，总长 ≤60 且保住尾部 -NN：
    超长时从最长的中间段腾位，不从尾部砍。"""
    tail = f"-{site_abbr}-{serial:02d}{ext}"
    budget = 60 - len(tail)
    parts = [topic, subtopic, point]
    while len("-".join(parts)) > budget:
        longest_index = max(range(len(parts)), key=lambda i: len(parts[i]))
        if len(parts[longest_index]) <= 1:
            break
        parts[longest_index] = parts[longest_index][:-1].rstrip("-")
    name = "-".join(part for part in parts if part) + tail
    return name if len(name) <= 60 else name[: 60 - len(ext) - len(f"-{serial:02d}")] + tail


async def scout_images(
    base: Path,
    emit: Any = None,
    extra_sites: list[str] | None = None,
) -> dict[str, Any]:
    """主入口：抓图、写 pool.md、跑 check_pool 自检。返回 {downloaded, gaps, sites}。

    事件（emit 可为 None）：stage 采图 start/done。任何失败只记 Gaps，不抛异常。
    """
    if is_fixture_mode():
        # E2E fixture：不联网，行为与真实入口一致（事件形态相同）
        if emit is not None:
            await emit(
                {
                    "event": "stage",
                    "stage": "采图",
                    "status": "done",
                    "downloaded": 0,
                    "gaps": ["fixture 模式：不联网采图"],
                }
            )
        return {"downloaded": 0, "gaps": ["fixture 模式：不联网采图"], "sites": []}

    if emit is not None:
        await emit({"event": "stage", "stage": "采图", "status": "start"})
    pool_dir = base / POOL_DIR_REL
    pool_dir.mkdir(parents=True, exist_ok=True)
    index_path = base / POOL_INDEX_REL

    resources = base / "RESOURCES.md"
    urls = extract_resource_urls(
        resources.read_text(encoding="utf-8") if resources.is_file() else ""
    )
    allowed_hosts = {_site_of(url) for url in urls} | {
        _site_of(f"https://{host}") for host in (extra_sites or [])
    }

    used_topics: set[str] = set()
    rows: list[str] = []
    gaps: list[str] = []
    downloaded = 0
    site_pages: dict[str, int] = {}
    site_downloads: dict[str, int] = {}
    seen_pages: set[str] = set()
    robots_cache: dict[str, RobotFileParser | None] = {}
    throttle = _Throttle()

    timeout = httpx.Timeout(15.0)
    headers = {"User-Agent": "StudyMateWeb-ImageScout/1.0 (personal learning use)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=False) as client:
        for entry_url in urls:
            site = _site_of(entry_url)
            if site not in allowed_hosts:
                continue
            if site_downloads.get(site, 0) >= IMAGES_PER_SITE:
                continue
            if site_pages.get(site, 0) >= PAGES_PER_SITE:
                continue
            # (url, depth)：入口 0 跳，站内下钻最多两跳
            queue: list[tuple[str, int]] = [(entry_url, 0)]
            while (
                queue
                and site_pages.get(site, 0) < PAGES_PER_SITE
                and site_downloads.get(site, 0) < IMAGES_PER_SITE
            ):
                page_url, depth = queue.pop(0)
                if page_url in seen_pages or _site_of(page_url) != site:
                    continue
                seen_pages.add(page_url)
                try:
                    if not await _allowed(client, page_url, robots_cache, throttle):
                        gaps.append(f"{page_url}：robots 不允许抓取")
                        continue
                    response = await _get_with_redirects(client, page_url, throttle, site)
                except (httpx.HTTPError, ValueError) as exc:
                    gaps.append(f"{page_url}：抓取失败（{type(exc).__name__}: {exc}）")
                    continue
                if response.status_code >= 400:
                    gaps.append(f"{page_url}：HTTP {response.status_code}")
                    continue
                content_type = response.headers.get("content-type", "")
                if "html" not in content_type:
                    gaps.append(f"{page_url}：不是网页（{content_type or '类型未知'}）")
                    continue
                site_pages[site] = site_pages.get(site, 0) + 1
                collector = _ImgCollector()
                try:
                    collector.feed(response.text)
                except Exception:  # noqa: BLE001 - 解析失败当无图处理
                    continue
                for info in collector.images:
                    if site_downloads.get(site, 0) >= IMAGES_PER_SITE:
                        break
                    src = (info.get("src") or "").strip()
                    if not src or src.startswith("data:"):
                        continue
                    image_url = urljoin(page_url, src)
                    ext = Path(urlparse(image_url).path).suffix.lower()
                    if ext not in IMAGE_EXTS:
                        continue
                    width = _attr_width(info)
                    if width is not None and width < MIN_WIDTH:
                        continue
                    filename_guess = Path(urlparse(image_url).path).name
                    if _looks_decorative(info, filename_guess):
                        continue
                    try:
                        data = await _download_image(client, image_url, throttle, site, robots_cache)
                    except (httpx.HTTPError, ValueError):
                        continue
                    if data is None:
                        continue
                    if len(data) > MAX_BYTES or len(data) < 1024:
                        gaps.append(f"{image_url}：体积 {len(data)} 字节超限或过小")
                        continue
                    dims = _image_dimensions(data, ext)
                    if dims is not None and dims[0] < MIN_WIDTH:
                        continue
                    topic = _pick_topic(base, used_topics)
                    subtopic = _sanitize_segment(_page_title(response.text) or site, 14) or site
                    point = _sanitize_segment(info.get("alt") or "要点", 14) or "配图"
                    site_abbr = _sanitize_segment(site.split(".")[0], 14) or "site"
                    serial = site_downloads.get(site, 0) + 1
                    filename = _build_filename(topic, subtopic, point, site_abbr, serial, ext)
                    (pool_dir / filename).write_bytes(data)
                    rows.append(
                        _new_row(
                            filename,
                            f"{topic}-{subtopic}",
                            (info.get("alt") or f"{topic}配图").strip()[:40],
                            page_url,
                            "未标注",
                            dims or (0, 0),
                        )
                    )
                    site_downloads[site] = serial
                    downloaded += 1
                # 站内下钻（最多两跳）：收同站的分类/画廊链接作为下一页候选
                if depth < _LINK_DEPTH_LIMIT:
                    for link in re.findall(r'href="([^"#]+)"', response.text):
                        candidate = urljoin(page_url, link)
                        if _site_of(candidate) == site and candidate not in seen_pages:
                            queue.append((candidate, depth + 1))

    _write_index(index_path, rows, gaps)
    gaps.extend(_run_pool_check(base))

    if emit is not None:
        await emit(
            {
                "event": "stage",
                "stage": "采图",
                "status": "done",
                "downloaded": downloaded,
                "gaps": gaps[:20],
            }
        )
    return {"downloaded": downloaded, "gaps": gaps[:20], "sites": sorted(site_pages)}


async def _download_image(
    client: httpx.AsyncClient,
    image_url: str,
    throttle: _Throttle,
    site: str,
    robots_cache: dict[str, RobotFileParser | None],
) -> bytes | None:
    """下载位图：SSRF 校验 + robots + 限速 + 手动重定向；失败返回 None。"""
    current = image_url
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(current)
        if urlparse(current).path.lower().endswith(".pdf"):
            return None
        if not await _allowed(client, current, robots_cache, throttle):
            return None
        await throttle.wait(site)
        response = await client.get(current)
        if response.is_redirect:
            location = response.headers.get("location")
            if not location:
                return None
            current = urljoin(current, location)
            continue
        if response.status_code >= 400:
            return None
        return response.content
    return None


def _run_pool_check(base: Path) -> list[str]:
    """check_pool.py 自检；任何异常只转 Gaps，不抛出（图片库为空也合格）。"""
    gate = SCRIPTS_DIR / "check_pool.py"
    if not gate.is_file():
        return ["自检脚本缺失：scripts/check_pool.py"]
    import os

    try:
        check = subprocess.run(
            [sys.executable, "-B", str(gate), str(base)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        if check.returncode != 0:
            return [line.strip() for line in (check.stdout or "").splitlines() if line.strip()]
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        return [f"自检执行失败：{type(exc).__name__}: {exc}"]
    return []


def _page_title(html: str) -> str:
    match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _write_index(index_path: Path, rows: list[str], gaps: list[str]) -> None:
    """索引只增不删：保留已有数据行，追加新行与 Gaps。"""
    existing: list[str] = []
    if index_path.is_file():
        for line in index_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("## "):
                break
            if stripped.startswith("|") and stripped != INDEX_HEADER and not re.match(r"^\|[\s:-]+\|", stripped):
                existing.append(stripped)
    known_files = {row.split("|")[1].strip() for row in existing if len(row.split("|")) > 1}
    fresh = [row for row in rows if row.split("|")[1].strip() not in known_files]
    lines = ["# 图片库索引", "", INDEX_HEADER, "|---|---|---|---|---|---|---|", *existing, *fresh, "", "## Gaps", ""]
    if gaps:
        lines.extend(f"- {gap}" for gap in gaps)
    else:
        lines.append("-（暂无）")
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
