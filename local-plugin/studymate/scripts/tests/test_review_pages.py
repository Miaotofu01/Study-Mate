import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class PageTest(unittest.TestCase):
 def test_review_assets_and_source_sync_snapshot(self):
  from data_store import write_yaml
  from review_scheduler import register_items
  from render_review import render_review
  import lessonfile,gen_home
  with tempfile.TemporaryDirectory() as d:
   ws=Path(d);s=ws/'.learning/subjects/test';s.mkdir(parents=True)
   write_yaml(s/'curriculum.yaml',{'nodes':[{'id':'one','objective':'Recall','title':'One','kind':'概念','prerequisites':[],'status':'未开始'}],'edges':[]})
   register_items(s,{'items':[{'node_id':'one','origin_key':'x','prompt':'Q','answer':'A','criteria':'A'}]})
   lessonfile.install_subject(str(s));lessonfile.install_shared(str(ws));(s/'index.html').write_text('index',encoding='utf-8')
   render_review(s);page=s/'reviews.html'
   self.assertEqual(gen_home.find_broken_links([str(page)],str(ws)),[])
   self.assertIn('synced_at',page.read_text(encoding='utf-8'))
if __name__=='__main__':unittest.main()

