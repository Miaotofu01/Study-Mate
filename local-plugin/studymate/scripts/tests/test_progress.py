import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import statuses
import gen_home


class ProgressTest(unittest.TestCase):
    def test_review_is_not_done(self):
        self.assertNotIn('需要复习', statuses.DONE_STATUSES)

    def test_verified_requires_evidence(self):
        nodes = [dict(status='需要复习', mastery=.2, title='A'),
                 dict(status='能独立应用', mastery=.9, title='B'),
                 dict(status='能独立应用', mastery=.8, title='C', evidence_verified=True)]
        self.assertEqual(gen_home.node_stats(nodes)[1], 1)
        metrics = gen_home.progress_metrics(nodes)
        self.assertEqual((metrics['learned'], metrics['verified'], metrics['review']), (3, 1, 1))


if __name__ == '__main__':
    unittest.main()
