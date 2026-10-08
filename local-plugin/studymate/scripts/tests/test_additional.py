import sys,unittest,tempfile,uuid,zipfile,json
from pathlib import Path
from datetime import datetime,timezone,timedelta
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from data_store import *
class AdditionalTest(unittest.TestCase):
 def test_early_and_late_match_official(self):
  from fsrs import Card,Rating,Scheduler
  from fsrs_adapter import default_config,apply_review
  cfg=default_config();sched=Scheduler.from_dict(cfg['scheduler']);t=datetime(2025,1,1,tzinfo=timezone.utc);official=Card(card_id=22,due=t);actual=None
  for days,rating in [(0,3),(1,3),(40,1),(42,4)]:
   official,log=sched.review_card(official,Rating(rating),review_datetime=t+timedelta(days=days))
   actual,alog=apply_review(actual,22,rating,t+timedelta(days=days),cfg)
   self.assertEqual(actual,official.to_dict());self.assertEqual(alog,log.to_dict())
 def test_version_identity_and_timezone(self):
  import review_scheduler as r
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);(s/'curriculum.yaml').write_text('nodes:\n- id: one\n  objective: Explain\n',encoding='utf-8')
   raw={'node_id':'one','origin_key':'origin','prompt':'Q','answer':'A','criteria':'A'};a=r.register_items(s,{'items':[raw]})['items'][0]
   self.assertEqual(r.register_items(s,{'items':[raw]})['items'][0]['review_item_id'],a['review_item_id'])
   b=r.register_items(s,{'items':[dict(raw,answer='Changed')]})['items'][-1]
   self.assertNotEqual(a['review_item_id'],b['review_item_id']);self.assertEqual(len(r.build_queue(s,datetime.now(timezone.utc))),1)
   self.assertEqual(r.build_queue(s,datetime(2025,1,1,16,1,tzinfo=timezone.utc))[0]['due_date'],'2025-01-02')
   with locked(s):
    with self.assertRaises(ValueError):r.build_queue(s,datetime.now(timezone.utc))
 def test_epub_spine_and_pdf_empty_pages(self):
  import source_index as x
  from pypdf import PdfWriter
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);s=p/'s';s.mkdir();raw=p/'raw';raw.mkdir()
   writer=PdfWriter();writer.add_blank_page(width=100,height=100)
   with (raw/'扫描.pdf').open('wb') as f:writer.write(f)
   with zipfile.ZipFile(raw/'日语.epub','w') as z:
    z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="O/content.opf"/></rootfiles></container>')
    z.writestr('O/content.opf','<package><manifest><item id="b" href="b.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>')
    z.writestr('O/a.xhtml','<h1 id="a">第一章</h1><p>記憶 学習</p>');z.writestr('O/b.xhtml','<h1>第二章</h1><p>memory</p>')
   x.scan(s,raw);hit=x.search(s,'記憶')[0];self.assertEqual(hit['locator']['spine_index'],0);self.assertEqual(hit['locator']['anchor'],'a')
   self.assertEqual(next(e for e in x.sources(s) if e['format']=='pdf')['extraction_status'],'needs_ocr')
 def test_revealed_before_answer_is_auxiliary(self):
  from learning_records import independent
  self.assertFalse(independent({'attempts':[{'answered_at':'2025-01-01T00:01:00Z','answer':'A','answer_revealed_at':'2025-01-01T00:00:00Z'}]}))
  self.assertTrue(independent({'answer_revealed_at':'2025-01-01T00:02:00Z','attempts':[{'answered_at':'2025-01-01T00:01:00Z','answer':'A'}]}))
if __name__=='__main__':unittest.main()

