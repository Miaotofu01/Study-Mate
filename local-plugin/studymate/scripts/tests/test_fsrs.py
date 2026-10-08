import sys,unittest,tempfile,uuid
from pathlib import Path
from datetime import datetime,timezone,timedelta
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class FSRSTest(unittest.TestCase):
 def test_adapter_matches_official_for_all_ratings(self):
  import fsrs_adapter as a
  from fsrs import Card,Rating,Scheduler
  from data_store import utc
  c=a.default_config();s=Scheduler.from_dict(c['scheduler']);t=datetime(2026,10,8,tzinfo=timezone.utc)
  for rating in range(1,5):
   expected,log=s.review_card(Card(card_id=12,due=t),Rating(rating),review_datetime=t)
   actual,alog=a.apply_review(None,12,rating,t,c)
   self.assertEqual(actual,expected.to_dict());self.assertEqual(alog,log.to_dict())
 def test_store_duplicate_out_of_order_correction_and_rebuild(self):
  import review_scheduler as r
  from data_store import read_json,write_json,utc
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);(s/'curriculum.yaml').write_text('nodes:\n- id: one\n  objective: Explain one\n',encoding='utf-8')
   item=r.register_items(s,{'items':[{'node_id':'one','origin_key':'book:p1','prompt':'Why?','answer':'Cause','criteria':'cause'}]})['items'][0]
   t=datetime(2025,10,8,tzinfo=timezone.utc)
   def event(day,rating):
    return dict(event_id=str(uuid.uuid4()),review_item_id=item['review_item_id'],item_version=item['item_version'],
      question_id=item['question_id'],question_version=item['question_version'],round_id=str(uuid.uuid4()),reviewed_at=(t+timedelta(days=day)).isoformat(),
      rating=rating,answer='Cause',help={},independent_attempt=True)
   e1,e2=event(0,3),event(5,3)
   r.ingest_reviews(s,[e2],'test');r.ingest_reviews(s,[e1],'test')
   before=r.build_queue(s,t+timedelta(days=100))[0]
   self.assertEqual(before['review_count'],2)
   self.assertEqual(r.ingest_reviews(s,[e1],'test')['accepted'],0)
   self.assertEqual(r.ingest_reviews(s,[dict(e1,event_id=str(uuid.uuid4()))],'test')['accepted'],0)
   r.correct_review(s,e2['event_id'],1,'misclick')
   after=r.build_queue(s,t+timedelta(days=100))[0];self.assertEqual(after['review_count'],2)
   self.assertNotEqual(before['due'],after['due'])
   r.rebuild_schedule(s);self.assertEqual(after['due'],r.build_queue(s,t+timedelta(days=100))[0]['due'])
   (s/'reviews/schedule.sqlite3').write_bytes(b'broken cache')
   self.assertEqual(after['due'],r.build_queue(s,t+timedelta(days=100))[0]['due'])
 def test_assistance_and_future_do_not_schedule(self):
  import review_scheduler as r
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);(s/'curriculum.yaml').write_text('nodes:\n- id: one\n  objective: Explain one\n',encoding='utf-8')
   item=r.register_items(s,{'items':[{'node_id':'one','origin_key':'x','prompt':'Q','answer':'A','criteria':'A'}]})['items'][0]
   e=dict(event_id=str(uuid.uuid4()),review_item_id=item['review_item_id'],item_version=item['item_version'],
     question_id=item['question_id'],question_version=item['question_version'],round_id=str(uuid.uuid4()),
     reviewed_at=datetime.now(timezone.utc).isoformat(),rating=3,answer='A',help={'used_hint':True},independent_attempt=False)
   result=r.ingest_reviews(s,[e],'test')
   self.assertEqual(result['accepted'],0);self.assertEqual(len(result['pending']),1)
   self.assertEqual(r.build_queue(s,datetime.now(timezone.utc))[0]['review_count'],0)
   e=dict(e,event_id=str(uuid.uuid4()),help={},independent_attempt=True,reviewed_at=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat())
   self.assertEqual(r.ingest_reviews(s,[e],'test')['pending'][0]['reason'],'future_timestamp')
   e=dict(e,event_id=str(uuid.uuid4()),reviewed_at=datetime.now(timezone.utc).isoformat(),forgot=True,rating=1)
   r.ingest_reviews(s,[e],'test')
   with self.assertRaises(ValueError): r.correct_review(s,e['event_id'],4,'misclick')
if __name__=='__main__':unittest.main()
