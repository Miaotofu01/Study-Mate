import unittest,sys,tempfile,zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class SourceTest(unittest.TestCase):
 def test_incremental_missing_search_and_existing_course(self):
  import source_index as x
  import course_import as c
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);s=p/'subject';s.mkdir();raw=p/'raw';raw.mkdir();f=raw/'book.md';f.write_text('# 第一章\n遗忘曲线 testing memory\n# 第二章\n独立回忆\n',encoding='utf-8')
   original=f.read_bytes();result=x.scan(s,raw)
   self.assertEqual(f.read_bytes(),original);self.assertEqual(result['changed'],1)
   hits=x.search(s,'遗忘');self.assertTrue(hits);sid=hits[0]['source_id'];ver=hits[0]['source_version']
   self.assertEqual(x.scan(s,raw)['changed'],0)
   manifest={'course_mode':'existing','units':[{'unit_id':'original-01','title':'Original chapter','objective':'Explain memory','source_refs':[{'source_id':sid,'source_version':ver,'locator':hits[0]['locator']}],'assignments':['https://example.org/hw']} ]}
   c.apply_course(s,manifest);self.assertEqual(c.apply_course(s,manifest)['changed'],False)
   from data_store import read_yaml
   node=read_yaml(s/'curriculum.yaml')['nodes'][0];self.assertEqual(node['id'],'original-01');self.assertEqual(node['assignments'],['https://example.org/hw'])
   f.unlink();x.scan(s,raw);self.assertEqual(x.sources(s)[0]['availability'],'missing');self.assertTrue(x.search(s,'遗忘'))
 def test_html_and_subtitle_locators(self):
  import source_index as x
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);s=p/'s';s.mkdir();raw=p/'raw';raw.mkdir()
   (raw/'a.html').write_text('<h1 id="week1">Week One</h1><p>Welcome memory</p><a href="hw.html">Homework</a>',encoding='utf-8')
   (raw/'a.vtt').write_text('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nRecall memory\n',encoding='utf-8')
   x.scan(s,raw);hits=x.search(s,'memory');self.assertTrue(any('timestamp' in h['locator'] for h in hits));self.assertTrue(any('heading' in h['locator'] for h in hits))
if __name__=='__main__':unittest.main()
