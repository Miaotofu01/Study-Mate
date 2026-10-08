import unittest,tempfile,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class WorkspaceTest(unittest.TestCase):
 def test_migration_idempotence_and_scoped_cleanup(self):
  import workspace_tools as w
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'.learning/subjects/math').mkdir(parents=True)
   old=p/'.learning/subjects/math/progress.yaml';old.write_text('nodes: {}\n',encoding='utf-8');raw=old.read_bytes()
   self.assertTrue(w.migrate(p)['migrated']);self.assertFalse(w.migrate(p)['migrated']);self.assertEqual(old.read_bytes(),raw)
   s=p/'.learning/subjects/math';a=w.stage(s,'a','role-node');b=w.stage(s,'b','role-node');(a/'x').write_text('x');(b/'x').write_text('b')
   w.clean_stage(s,'a','role-node');self.assertTrue((b/'x').exists())
   with self.assertRaises(ValueError): w.clean_stage(s,'../b','role-node')
if __name__=='__main__':unittest.main()
