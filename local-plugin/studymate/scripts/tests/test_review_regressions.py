import unittest,tempfile,sys,uuid,os
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from data_store import *
class RegressionTest(unittest.TestCase):
 def test_objective_change_creates_new_question_version(self):
  from quiz_identity import prepare_quiz
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);write_yaml(s/'curriculum.yaml',{'nodes':[{'id':'one','objective':'Before'}]});q={'x':[{'q':'Q','answer':'A','criteria':'A'}]}
   a=prepare_quiz(s,'one',q)['x'][0];write_yaml(s/'curriculum.yaml',{'nodes':[{'id':'one','objective':'After'}]});b=prepare_quiz(s,'one',q)['x'][0]
   self.assertEqual(a['question_id'],b['question_id']);self.assertNotEqual(a['question_version'],b['question_version'])
 def test_short_vtt_not_silently_lost(self):
  from source_index import extract
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'short.vtt';p.write_text('WEBVTT\n\n00:01.000 --> 00:03.000\nRecall memory\n',encoding='utf-8')
   rows,_,status=extract(p);self.assertEqual(rows[0]['text'],'Recall memory');self.assertEqual(status,'ready')
 def test_course_retry_after_interrupted_write(self):
  import course_import as c
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);m={'course_mode':'existing','units':[{'unit_id':'one','title':'One','objective':'Explain'}]}
   with patch.object(c,'write_yaml',side_effect=OSError('interruption')):
    with self.assertRaises(OSError):c.apply_course(s,m)
   self.assertTrue(c.apply_course(s,m)['changed']);self.assertTrue((s/'curriculum.yaml').exists())
 def test_relocated_node_preserves_card_updates_catalog(self):
  import review_scheduler as r
  from quiz_identity import get_question
  with tempfile.TemporaryDirectory() as d:
   s=Path(d);write_yaml(s/'curriculum.yaml',{'nodes':[{'id':'one','objective':'Explain'},{'id':'two','objective':'Explain'}]})
   raw={'node_id':'one','origin_key':'o','prompt':'Q','answer':'A','criteria':'A'};a=r.register_items(s,{'items':[raw]})['items'][0]
   b=r.register_items(s,{'items':[dict(raw,node_id='two')]})['items'][0]
   self.assertEqual(a['review_item_id'],b['review_item_id']);self.assertEqual(get_question(s,b['question_id'],b['question_version'])['node_id'],'two')
 @unittest.skipUnless(os.name=='nt','Windows junction protection')
 def test_internal_junction_cannot_redirect_cache(self):
  import _winapi,review_scheduler as r
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);s=p/'subject';s.mkdir();out=p/'original';out.mkdir();link=s/'reviews';_winapi.CreateJunction(str(out),str(link))
   try:
    from datetime import datetime,timezone
    with self.assertRaises(ValueError):r.build_queue(s,datetime.now(timezone.utc))
    self.assertFalse((out/'schedule.sqlite3').exists())
   finally:os.rmdir(link)
 @unittest.skipUnless(os.name=='nt','Windows junction protection')
 def test_junction_cannot_redirect_writes(self):
  import _winapi
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);ws=p/'workspace';original=p/'original';original.mkdir();(ws/'.learning/subjects').mkdir(parents=True)
   link=ws/'.learning/subjects/test';_winapi.CreateJunction(str(original),str(link))
   try:
    with self.assertRaises(ValueError):subject_path(ws,'test')
   finally:os.rmdir(link)
if __name__=='__main__':unittest.main()
