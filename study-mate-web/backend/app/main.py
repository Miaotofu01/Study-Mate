"""StudyMate Web 运行时 — FastAPI 入口。

阶段 3：课件展示、判分、评估与小结、静态导出、科目生成，加上
既有的 LLM 对话（SSE 流式）、多 Provider 设置与附件上传解析。
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import curriculum_store
from .config import ensure_dirs, load_settings
from .routers import (
    chat,
    courses,
    export,
    generate,
    home,
    lessons,
    misconceptions,
    memory,
    practice,
    production,
    records,
    settings_router,
    uploads,
    workspace,
    workspace_files,
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_dirs()
    load_settings()
    curriculum_store.ensure_workspace()
    uploads.cleanup_pending()
    yield


app = FastAPI(title="StudyMate Web Runtime", version="0.7.0-beta", lifespan=lifespan)

# CORS 只服务「浏览器直连后端」的跨域场景：前端所有 /api 一律走 Next 同源代理，
# 正常使用不会命中这里，故白名单只收本机三个前端端口的来源。
# 绝不允许 allow_origins=["*"] 与 allow_credentials=True 组合：Starlette 会把
# Access-Control-Allow-Origin 反射成请求方 Origin，等价对任意网站放开——用户浏览器里
# 的任何网页都能跨域读本机 API（含 GET /api/settings）。
_CORS_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (3800, 3801, 3810)  # dev / 生产 / E2E 前端
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(settings_router.router)
app.include_router(workspace.router)
app.include_router(uploads.router)
app.include_router(courses.router)
app.include_router(misconceptions.router)
app.include_router(memory.router)
app.include_router(lessons.router)
app.include_router(workspace_files.router)
app.include_router(home.router)
app.include_router(practice.router)
app.include_router(records.router)
app.include_router(export.router)
app.include_router(generate.router)
app.include_router(production.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
