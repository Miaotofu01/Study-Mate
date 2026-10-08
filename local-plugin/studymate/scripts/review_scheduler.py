"""Append-only review events; SQLite is a disposable chronological projection."""
import argparse,copy,json,sqlite3,sys,uuid
import hashlib
from pathlib import Path
from datetime import datetime,timezone,timedelta
from data_store import *
from quiz_identity import prepare_quiz,get_question
from fsrs_adapter import default_config,apply_review
SHANGHAI=timezone(timedelta(hours=8))
def registry(s): return read_json(Path(s)/'reviews/items.json',{'schema_version':1,'items':[]})
def configuration(s):
    p=Path(s)/'reviews/config.json';c=read_json(p)
    if not c:
        c=default_config();write_json(p,c)
    if c.get('config_version')!=digest({k:v for k,v in c.items() if k!='config_version'}): raise ValueError('config content/version mismatch')
    immutable(Path(s)/'reviews/configs'/(c['config_version']+'.json'),c)
    return c
def register_items(subject_dir,manifest):
    s=Path(subject_dir)
    with locked(s):
        cur=read_yaml(s/'curriculum.yaml',{}) or {};nodes={n['id'] for n in cur.get('nodes',[])}
        data=registry(s);configuration(s)
        for raw in manifest.get('items',[]):
            for key in ('node_id','origin_key','prompt','answer','criteria'):
                if not isinstance(raw.get(key),str) or not raw[key].strip(): raise ValueError('missing '+key)
            if raw['node_id'] not in nodes: raise ValueError('unknown node')
            if raw.get('kind','key_point') not in ('key_point','mistake'): raise ValueError('invalid review kind')
            ver=digest({k:raw[k] for k in ('prompt','answer','criteria')})
            match=next((x for x in data['items'] if x['origin_key']==raw['origin_key'] and x['item_version']==ver),None)
            if match:
                # Relocation and renumbering are metadata, not memory resets.
                if match['node_id']!=raw['node_id']:
                    match.setdefault('question_history',[]).append({'question_id':match['question_id'],'question_version':match['question_version']})
                    q={'question_id':str(uuid.uuid5(uuid.UUID(match['review_item_id']),'recall:'+raw['node_id'])),'review_item_id':match['review_item_id'],'q':raw['prompt'],'answer':raw['answer'],'criteria':raw['criteria']}
                    q=prepare_quiz(s,raw['node_id'],{'review':[q]})['review'][0]
                    match['question_id']=q['question_id'];match['question_version']=q['question_version']
                match['node_id']=raw['node_id'];match['source_refs']=raw.get('source_refs',[])
                continue
            for old in data['items']:
                if old['origin_key']==raw['origin_key'] and old['status']=='active': old['status']='archived'
            for attempt in range(8):
                iid=str(uuid.uuid4());card_id=int(hashlib.sha256(iid.encode()).hexdigest()[:13],16)
                if card_id and not any(x['fsrs_card_id']==card_id or x['review_item_id']==iid for x in data['items']): break
            else: raise ValueError('cannot allocate unique card identity')
            qid=str(uuid.uuid5(uuid.UUID(iid),'recall'))
            q={'question_id':qid,'review_item_id':iid,'q':raw['prompt'],'answer':raw['answer'],'criteria':raw['criteria']}
            q=prepare_quiz(s,raw['node_id'],{'review':[q]})['review'][0]
            item=dict(raw,review_item_id=iid,item_version=ver,question_id=qid,question_version=q['question_version'],fsrs_card_id=card_id,status='active',created_at=now())
            if any(x['fsrs_card_id']==item['fsrs_card_id'] for x in data['items']): raise ValueError('card ID collision; retry registration')
            data['items'].append(item)
        write_json(s/'reviews/items.json',data)
        _rebuild(s)
        return data
def _events(s): return [read_json(p) for p in sorted((Path(s)/'reviews/events').glob('*.json'))]
def _rebuild(s):
    try: return _rebuild_once(s)
    except sqlite3.DatabaseError:
        # Only this disposable projection is removed; events/items remain intact.
        safe_path(Path(s)/'reviews/schedule.sqlite3').unlink(missing_ok=True)
        return _rebuild_once(s)
def _rebuild_once(s):
    data=registry(s);config=configuration(s);events=_events(s)
    signature=digest({'items':data,'events':events,'config':config})
    p=safe_path(Path(s)/'reviews/schedule.sqlite3');p.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(p)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS meta (signature TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS cards (item_id TEXT PRIMARY KEY, card TEXT, review_count INTEGER, last_review TEXT)')
        existing=db.execute('SELECT signature FROM meta').fetchone()
        if existing and existing[0]==signature: return {'signature':signature,'rebuilt':False}
        corrections={}
        for e in sorted(events,key=lambda x:(x.get('created_at',''),x['event_id'])):
            if e['type']=='correction': corrections[e['target_event_id']]=e['rating']
        cards={};counts={};last={}
        for wrapper in sorted((e for e in events if e['type']=='review'),key=lambda x:(x['event']['reviewed_at'],x['event_id'])):
            e=wrapper['event'];iid=e['review_item_id'];item=next((i for i in data['items'] if i['review_item_id']==iid),None)
            if not item: raise ValueError('missing historical review item')
            cfg=read_json(Path(s)/'reviews/configs'/(wrapper['config_version']+'.json'))
            card,log=apply_review(cards.get(iid),item['fsrs_card_id'],corrections.get(e['event_id'],e['rating']),utc(e['reviewed_at']),cfg,e.get('duration_ms'))
            cards[iid]=card;counts[iid]=counts.get(iid,0)+1;last[iid]=e['reviewed_at']
        with db:
            db.execute('DELETE FROM cards');db.execute('DELETE FROM meta')
            db.execute('INSERT INTO meta VALUES (?)',(signature,))
            for iid,card in cards.items(): db.execute('INSERT INTO cards VALUES (?,?,?,?)',(iid,canonical(card),counts[iid],last[iid]))
        return {'signature':signature,'rebuilt':True}
    finally: db.close()
def rebuild_schedule(s):
    with locked(s):
        p=safe_path(Path(s)/'reviews/schedule.sqlite3')
        if p.exists(): p.unlink()
        return _rebuild(s)
def ingest_reviews(subject_dir,events,evidence_ref):
    s=Path(subject_dir);accepted=0;pending=[];seen=set()
    with locked(s):
        items={i['review_item_id']:i for i in registry(s)['items']};cfg=configuration(s)
        configs=[read_json(p) for p in (s/'reviews/configs').glob('*.json')]
        for raw in events:
            e=copy.deepcopy(raw);eid=str(uuid.UUID(e['event_id']))
            if eid in seen: raise ValueError('duplicate event in export')
            seen.add(eid);item=items.get(e.get('review_item_id'))
            if not item or e.get('item_version')!=item['item_version'] or not any(all(e.get(k)==q[k] for k in ('question_id','question_version')) for q in [item]+item.get('question_history',[])): raise ValueError('unknown review item/version')
            get_question(s,e['question_id'],e['question_version'])
            str(uuid.UUID(e['round_id']))
            if type(e.get('rating'))!=int or e['rating'] not in (1,2,3,4): raise ValueError('invalid rating')
            reviewed=utc(e['reviewed_at']);e['reviewed_at']=reviewed.isoformat()
            if not e.get('answer') and not e.get('forgot'): raise ValueError('answer or explicit forgotten flag required')
            reason=None
            if reviewed>datetime.now(timezone.utc)+timedelta(minutes=5): reason='future_timestamp'
            elif not e.get('independent_attempt') or any(e.get('help',{}).get(k) for k in ('used_hint','used_reference','used_ai')): reason='assisted_attempt'
            elif e.get('forgot') or e.get('first_correct') is False:
                if e['rating']!=1: reason='failure_requires_again'
            if e.get('answer_revealed_at') and utc(e['answer_revealed_at'])<=reviewed: reason='answer_already_revealed'
            p=s/'reviews/events'/(eid+'.json');old=read_json(p)
            if old:
                if old.get('type')!='review' or digest(old['event'])!=digest(e): raise ValueError('event ID conflict')
                continue
            same_round=next((w['event'] for w in _events(s) if w['type']=='review' and w['event']['review_item_id']==e['review_item_id'] and w['event']['round_id']==e['round_id']),None)
            if same_round:
                if digest({k:v for k,v in same_round.items() if k!='event_id'})!=digest({k:v for k,v in e.items() if k!='event_id'}): raise ValueError('conflicting rating in the same recall round')
                continue
            pp=s/'reviews/pending'/(eid+'.json');previous=read_json(pp)
            if previous:
                if digest(previous['event'])!=digest(e): raise ValueError('pending event ID conflict')
                pending.append({'event_id':eid,'reason':previous['reason']});continue
            if reason:
                immutable(pp,{'schema_version':1,'event':e,'reason':reason,'evidence_ref':str(evidence_ref),'imported_at':now()})
                pending.append({'event_id':eid,'reason':reason});continue
            effective=sorted((c for c in configs if utc(c['effective_from'])<=reviewed),key=lambda c:utc(c['effective_from']))
            selected=effective[-1] if effective else cfg
            immutable(p,{'schema_version':1,'type':'review','event_id':eid,'event':e,'config_version':selected['config_version'],'evidence_ref':str(evidence_ref),'created_at':now()});accepted+=1
        _rebuild(s)
    return {'accepted':accepted,'pending':pending}
def correct_review(s,event_id,rating,reason):
    if type(rating)!=int or rating not in (1,2,3,4) or not reason.strip(): raise ValueError('rating and correction reason required')
    with locked(s):
        target=read_json(Path(s)/'reviews/events'/(str(uuid.UUID(event_id))+'.json'))
        if not target or target['type']!='review': raise ValueError('unknown review event')
        if rating!=1 and (target['event'].get('forgot') or target['event'].get('first_correct') is False): raise ValueError('failed original attempt requires Again')
        eid=str(uuid.uuid4())
        immutable(Path(s)/'reviews/events'/(eid+'.json'),{'schema_version':1,'type':'correction','event_id':eid,'target_event_id':event_id,'rating':rating,'reason':reason,'created_at':now()})
        return _rebuild(s)
def build_queue(s,at):
    at=utc(at);today=at.astimezone(SHANGHAI).date();rows=[]
    with locked(s):
        _rebuild(s);db=sqlite3.connect(safe_path(Path(s)/'reviews/schedule.sqlite3'))
        try: cards={r[0]:(json.loads(r[1]),r[2],r[3]) for r in db.execute('SELECT * FROM cards')}
        finally: db.close()
        for item in registry(s)['items']:
            if item['status']!='active': continue
            card,count,last=cards.get(item['review_item_id'],(None,0,None))
            due=utc(card['due']) if card else at;day=due.astimezone(SHANGHAI).date()
            rows.append(dict(item,due=due.isoformat(),due_date=str(day),review_count=count,last_review=last,queue_status='new' if not card else 'overdue' if day<today else 'due' if day==today else 'future',stability=card.get('stability') if card else None,difficulty=card.get('difficulty') if card else None))
    return sorted(rows,key=lambda r:(r['due'],r['review_item_id']))
def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--subject',required=True)
    sub=p.add_subparsers(dest='cmd',required=True)
    for name in ('register','record'):
        q=sub.add_parser(name);q.add_argument('--input',required=True)
    sub.add_parser('due');sub.add_parser('rebuild')
    q=sub.add_parser('correct');q.add_argument('--event-id',required=True);q.add_argument('--rating',type=int,required=True);q.add_argument('--reason',required=True)
    a=p.parse_args();s=subject_path(a.workspace,a.subject)
    if a.cmd=='register': result=register_items(s,read_json(a.input))
    elif a.cmd=='record':
        from learning_records import import_records
        result=import_records(a.workspace,a.subject,read_json(a.input))
    elif a.cmd=='due': result=[r for r in build_queue(s,datetime.now(timezone.utc)) if r['queue_status']!='future']
    elif a.cmd=='rebuild': result=rebuild_schedule(s)
    else: result=correct_review(s,a.event_id,a.rating,a.reason)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError) as e: print(str(e),file=sys.stderr);sys.exit(2)
