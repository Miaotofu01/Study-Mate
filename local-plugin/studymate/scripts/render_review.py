"""Build a static daily queue snapshot."""
import json
from pathlib import Path
from datetime import datetime,timezone
from data_store import atomic_text
from quiz_identity import workspace_id
from review_scheduler import build_queue
def render_review(sdir):
    sdir=Path(sdir);ws=sdir.resolve().parents[2]
    data={'meta':{'workspace_id':workspace_id(ws),'subject':sdir.name,'node_id':'reviews'},'synced_at':datetime.now(timezone.utc).isoformat(),'items':build_queue(sdir,datetime.now(timezone.utc))}
    payload=json.dumps(data,ensure_ascii=False).replace('<','\\u003c')
    page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StudyMate · 今日复习</title><link rel="stylesheet" href="assets/style.css"><body><article><h1>今日复习</h1><p>先回忆，再对照答案评分。列表按上海日期筛选；导入后刷新此页才能看到正式的新日期。</p><a href="index.html">返回科目</a><div id="review-list"></div></article><script id="review-data" type="application/json">'+payload+'</script><script src="assets/learning-records.js"></script><script src="assets/review.js"></script></body></html>'
    atomic_text(sdir/'reviews.html',page)
