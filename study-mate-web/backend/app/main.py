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
    lessons,
    misconceptions,
    practice,
    records,
    settings_router,
    uploads,
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_dirs()
    load_settings()
    curriculum_store.ensure_workspace()
    uploads.cleanup_pending()
    yield


app = FastAPI(title="StudyMate Web Runtime", version="0.4.0-beta", lifespan=lifespan)

# 开发阶段允许前端 dev server 跨域；生产由 Next.js 同源代理，CORS 不生效
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(settings_router.router)
app.include_router(uploads.router)
app.include_router(courses.router)
app.include_router(misconceptions.router)
app.include_router(lessons.router)
app.include_router(practice.router)
app.include_router(records.router)
app.include_router(export.router)
app.include_router(generate.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
