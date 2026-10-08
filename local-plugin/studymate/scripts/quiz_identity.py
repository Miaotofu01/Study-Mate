"""Stable question identities and immutable historical content snapshots."""
import copy, uuid
from pathlib import Path
from data_store import digest, immutable, locked, now, read_json, read_yaml, write_json

def workspace_id(workspace):
    learning=Path(workspace)/'.learning'
    with locked(learning,'.identity.lock'):
        path=learning/'workspace.json';data=read_json(path)
        if not data:
            data={'schema_version':1,'workspace_id':str(uuid.uuid4())};write_json(path,data)
        return data['workspace_id']
def question_version(question):
    return digest({k:v for k,v in question.items() if k not in ('question_id','question_version','review_item_id')})
def prepare_quiz(subject_dir,node_id,quiz,persist=True):
    subject_dir=Path(subject_dir);result=copy.deepcopy(quiz)
    cur=read_yaml(subject_dir/'curriculum.yaml',{}) or {}
    node=next((n for n in cur.get('nodes',[]) if n.get('id')==node_id),{})
    for anchor,questions in result.items():
        for i,q in enumerate(questions):
            # Legacy quizzes get repeatable IDs. New authors should provide a UUID.
            qid=q.get('question_id') or str(uuid.uuid5(uuid.NAMESPACE_URL,subject_dir.name+'/'+node_id+'/'+anchor+'/'+str(i)))
            uuid.UUID(qid);q['question_id']=qid;q['objective_hash']=digest(node.get('objective',''));q['question_version']=question_version(q)
            if persist:
                snapshot={'schema_version':1,'node_id':node_id,'question':q,'objective':node.get('objective','')}
                with locked(subject_dir,'.catalog.lock'):
                    immutable(subject_dir/'question-catalog'/qid/(q['question_version']+'.json'),snapshot)
    return result
def get_question(subject_dir,qid,version):
    uuid.UUID(qid)
    if len(version)!=64 or any(c not in '0123456789abcdef' for c in version): raise ValueError('invalid question version')
    snap=read_json(Path(subject_dir)/'question-catalog'/qid/(version+'.json'))
    if not snap: raise ValueError('unknown question identity/version')
    return snap
