"""Import immutable answers; assess only objectives covered by actual evidence."""
import argparse, copy, json, sys, uuid
from pathlib import Path
from data_store import *
from quiz_identity import get_question, workspace_id
import statuses

def uuid_text(value):
    uuid.UUID(value);return value
def original_attempt(record):
    attempts=record.get('attempts',[])
    if not attempts: raise ValueError('answer record needs an attempt')
    first=attempts[0]
    utc(first['answered_at'])
    if first.get('answer') is None or (isinstance(first.get('answer'),str) and not first['answer'].strip()):
        if not first.get('forgot'): raise ValueError('empty answer')
    return first
def independent(record):
    first=original_attempt(record)
    help_=first.get('help') or {}
    reveal=first.get('answer_revealed_at')
    return not any(help_.get(k) for k in ('used_hint','used_reference','used_ai')) and not (reveal and utc(reveal)<=utc(first['answered_at']))
def record_index(subject_dir):
    result={}
    for p in sorted((Path(subject_dir)/'learning-records'/'raw').glob('*.json')):
        data=read_json(p)
        for record in data['records']:
            rid=record['record_id']
            if rid in result and digest(result[rid])!=digest(record): raise ValueError('conflicting answer ID')
            result[rid]=record
    return result
def import_records(workspace,subject,payload):
    sdir=subject_path(workspace,subject)
    if payload.get('schema_version')!=1 or payload.get('subject')!=subject or payload.get('workspace_id')!=workspace_id(workspace):
        raise ValueError('workspace/subject/schema mismatch')
    eid=uuid_text(payload['export_id'])
    if not isinstance(payload.get('records'),list) or not payload['records']: raise ValueError('no answers')
    with locked(sdir):
        existing=record_index(sdir);seen=set()
        for record in payload['records']:
            rid=uuid_text(record['record_id']);uuid_text(record['round_id'])
            if rid in seen: raise ValueError('duplicate answer within export')
            seen.add(rid)
            snap=get_question(sdir,record['question_id'],record['question_version'])
            if snap['node_id']!=record['node_id']: raise ValueError('question/node mismatch')
            first=original_attempt(record)
            q=snap['question']
            if 'opts' in q and (type(first['answer']) is not int or not 0<=first['answer']<len(q['opts'])): raise ValueError('invalid choice')
            if rid in existing and digest(existing[rid])!=digest(record): raise ValueError('answer ID conflict')
            if record.get('fsrs'):
                e=record['fsrs']
                for key in ('question_id','question_version','round_id'):
                    if e.get(key)!=record[key]: raise ValueError('FSRS event/answer mismatch')
                if e.get('answer')!=first.get('answer') or utc(e['reviewed_at'])!=utc(first['answered_at']): raise ValueError('FSRS must use the original attempt')
                if e.get('help',{})!=first.get('help',{}) or e.get('independent_attempt')!=independent(record): raise ValueError('FSRS assistance mismatch')
                if bool(e.get('forgot'))!=bool(first.get('forgot')): raise ValueError('FSRS forgotten flag mismatch')
                if 'opts' in q and e.get('first_correct')!=(first['answer']==q['ans']): raise ValueError('FSRS correctness mismatch')
                if e.get('answer_revealed_at')!=first.get('answer_revealed_at'): raise ValueError('FSRS reveal timestamp mismatch')
        archive=sdir/'learning-records'/'raw'/(eid+'.json')
        fresh=immutable(archive,payload)
    events=[r['fsrs'] for r in payload['records'] if r.get('fsrs')]
    scheduling=None
    if events:
        from review_scheduler import ingest_reviews
        scheduling=ingest_reviews(sdir,events,str(archive))
    return {'duplicate':not fresh,'records':len(payload['records']),'evidence_ref':str(archive),'scheduling':scheduling}
def validate_result(sdir,result,records):
    cur=read_yaml(sdir/'curriculum.yaml',{}) or {}
    node=next((n for n in cur.get('nodes',[]) if n['id']==result['node_id']),None)
    if not node: raise ValueError('unknown node')
    if result.get('status') not in statuses.NODE_STATUSES: raise ValueError('invalid status')
    if node['objective'] not in result.get('covered_objectives',[]): raise ValueError('objective not covered')
    if not result.get('criterion') or not result.get('evidence'): raise ValueError('assessment needs criterion and evidence')
    strong=result['status'] in statuses.DONE_STATUSES
    if strong and (result.get('independent') is not True or result.get('verdict')!='通过'): raise ValueError('independent passed evidence required')
    for ref in result['evidence']:
        if 'record_id' in ref:
            record=records.get(ref['record_id'])
            if not record or record['node_id']!=node['id']: raise ValueError('evidence node mismatch')
            snap=get_question(sdir,record['question_id'],record['question_version'])
            if snap.get('objective')!=node['objective']: raise ValueError('objective changed since answer')
            if strong and not independent(record): raise ValueError('assisted evidence cannot prove independence')
            q=snap['question'];first=original_attempt(record)
            if strong and (first.get('forgot') or ('opts' in q and first['answer']!=q['ans'])): raise ValueError('failed original attempt cannot prove independence')
        elif 'artifact' in ref:
            artifact=Path(ref['artifact'])
            if not artifact.is_absolute() or not artifact.is_file() or ref.get('sha256')!=file_digest(artifact): raise ValueError('artifact hash/path mismatch')
        else: raise ValueError('unknown evidence reference')
    if 'mastery' in result and (type(result['mastery']) not in (int,float) or not 0<=result['mastery']<=1): raise ValueError('invalid AI suggestion')
    return node
def assess(workspace,subject,assessment):
    sdir=subject_path(workspace,subject);aid=uuid_text(assessment['assessment_id'])
    with locked(sdir):
        records=record_index(sdir)
        if not assessment.get('results'): raise ValueError('empty assessment')
        ids=[r['node_id'] for r in assessment['results']]
        if len(ids)!=len(set(ids)): raise ValueError('duplicate assessment node')
        nodes=[validate_result(sdir,r,records) for r in assessment['results']]
        path=sdir/'assessments'/(aid+'.json')
        immutable(path,assessment)
        prog=read_yaml(sdir/'progress.yaml',{}) or {'nodes':{},'misconceptions':[],'project':{'current':''}}
        if aid in prog.get('applied_assessments',[]): return {'duplicate':True}
        prog.setdefault('nodes',{});prog.setdefault('applied_assessments',[]).append(aid)
        for result,node in zip(assessment['results'],nodes):
            state=prog['nodes'].setdefault(node['id'],{})
            state['status']=result['status']
            if 'mastery' in result: state['mastery']=result['mastery']
            state.setdefault('mastery',0)
            state['verification']={'assessment_id':aid,'sha256':digest(assessment),'objective_hash':digest(node['objective'])}
        prog['updated_at']=now();write_yaml(sdir/'progress.yaml',prog)
    return {'duplicate':False,'updated_nodes':ids}
def verified_node_ids(subject_dir,prog):
    sdir=Path(subject_dir);result=set()
    try: records=record_index(sdir)
    except (ValueError,OSError): return result
    for nid,state in (prog or {}).get('nodes',{}).items():
        v=state.get('verification') or {}
        try:
            aid=uuid_text(v['assessment_id']);a=read_json(sdir/'assessments'/(aid+'.json'))
            if not a or digest(a)!=v['sha256']: continue
            entry=next(r for r in a['results'] if r['node_id']==nid)
            node=validate_result(sdir,entry,records)
            if state.get('status')==entry['status'] and state['status'] in statuses.DONE_STATUSES and digest(node['objective'])==v['objective_hash']:
                result.add(nid)
        except (KeyError,StopIteration,ValueError,OSError): continue
    return result
def validated_progress(sdir,prog):
    prog=copy.deepcopy(prog or {});verified=verified_node_ids(sdir,prog)
    for nid,state in prog.get('nodes',{}).items(): state['evidence_verified']=nid in verified
    return prog
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--workspace',required=True);p.add_argument('--subject',required=True)
    p.add_argument('command',choices=['import','assess']);p.add_argument('--input',required=True)
    a=p.parse_args(argv)
    try:
        result=(import_records if a.command=='import' else assess)(Path(a.workspace),a.subject,read_json(a.input))
        print(json.dumps(result,ensure_ascii=False));return 0
    except (ValueError,OSError,KeyError) as e: print(str(e),file=sys.stderr);return 1
if __name__=='__main__': sys.exit(main())
