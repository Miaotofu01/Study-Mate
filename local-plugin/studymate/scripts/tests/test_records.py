import sys, tempfile, unittest, json, uuid
from pathlib import Path
from datetime import datetime, timezone
import yaml
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class RecordsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ws = Path(self.temp.name)
        self.subject = self.ws / '.learning/subjects/test'
        (self.subject / 'lessons').mkdir(parents=True)
        (self.subject / 'curriculum.yaml').write_text(yaml.safe_dump({'nodes':[
            dict(id='one',title='One',objective='Explain one',prerequisites=[],kind='概念',status='未开始'),
            dict(id='two',title='Two',objective='Explain two',prerequisites=[],kind='概念',status='未开始')], 'edges':[]}), encoding='utf-8')
    def tearDown(self):
        self.temp.cleanup()
    def test_import_idempotent_and_assess_only_covered(self):
        import quiz_identity as qi, learning_records as lr
        quiz = qi.prepare_quiz(self.subject, 'one', {'a':[dict(q='why?',answer='because',criteria='cause')]})
        q = quiz['a'][0]
        payload = dict(schema_version=1, workspace_id=qi.workspace_id(self.ws), subject='test',
                       export_id=str(uuid.uuid4()), records=[dict(record_id=str(uuid.uuid4()),round_id=str(uuid.uuid4()),
                       node_id='one',question_id=q['question_id'],question_version=q['question_version'],
                       attempts=[dict(answer='because',answered_at=datetime.now(timezone.utc).isoformat(),help={})])])
        self.assertFalse(lr.import_records(self.ws, 'test', payload)['duplicate'])
        self.assertTrue(lr.import_records(self.ws, 'test', payload)['duplicate'])
        self.assertFalse((self.subject / 'progress.yaml').exists())
        assessment = dict(assessment_id=str(uuid.uuid4()), results=[dict(node_id='one',status='能独立应用',mastery=.8,
          independent=True,verdict='通过',criterion='explains cause',covered_objectives=['Explain one'],
          evidence=[dict(record_id=payload['records'][0]['record_id'])])])
        lr.assess(self.ws, 'test', assessment)
        prog=yaml.safe_load((self.subject/'progress.yaml').read_text(encoding='utf-8'))
        self.assertEqual(set(prog['nodes']), {'one'})
        self.assertEqual(lr.verified_node_ids(self.subject, prog), {'one'})
        payload['records'][0]['attempts'][0]['answer']='altered'
        with self.assertRaises(ValueError): lr.import_records(self.ws,'test',payload)
    def test_assisted_answer_cannot_promote(self):
        import quiz_identity as qi, learning_records as lr
        q=qi.prepare_quiz(self.subject,'one',{'a':[dict(q='why',answer='yes',criteria='yes') ]})['a'][0]
        p=dict(schema_version=1,workspace_id=qi.workspace_id(self.ws),subject='test',export_id=str(uuid.uuid4()),
          records=[dict(record_id=str(uuid.uuid4()),round_id=str(uuid.uuid4()),node_id='one',
            question_id=q['question_id'],question_version=q['question_version'],
            attempts=[dict(answer='yes',help={'used_hint':True},answered_at=datetime.now(timezone.utc).isoformat())])])
        lr.import_records(self.ws,'test',p)
        with self.assertRaises(ValueError):
            lr.assess(self.ws,'test',dict(assessment_id=str(uuid.uuid4()),results=[dict(node_id='one',status='能独立应用',
             independent=True,verdict='通过',criterion='yes',covered_objectives=['Explain one'],evidence=[{'record_id':p['records'][0]['record_id']}])]))

if __name__=='__main__': unittest.main()
