import unittest,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import interaction_state as i
class SessionTest(unittest.TestCase):
 def test_isolation_stale_revision_and_legacy(self):
  with tempfile.TemporaryDirectory() as d:
   w=Path(d);(w/'.learning').mkdir()
   data={k:i.initial_state()[k] for k in i.FIELDS};data['active_subject']='math'
   i.update_state(w,data,0,session_id='chat-a',subject='math')
   self.assertEqual(i.read_state(w,session_id='chat-a',subject='math')['revision'],1)
   self.assertEqual(i.read_state(w,session_id='chat-b',subject='math')['revision'],0)
   self.assertEqual(i.read_state(w)['revision'],0)
   with self.assertRaises(i.StateError): i.update_state(w,data,0,session_id='chat-a',subject='math')
   with self.assertRaises(i.StateError): i.read_state(w,session_id='../escape',subject='math')
if __name__=='__main__':unittest.main()
