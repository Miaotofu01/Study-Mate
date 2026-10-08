"""Keep an existing course's stable units, ordering and external assignments."""
import argparse,json,sys,re
from pathlib import Path
from data_store import *
from source_index import resolve
def apply_course(s,manifest,accept_changes=False):
    if manifest.get('course_mode') not in ('existing','generated'): raise ValueError('course_mode required')
    units=manifest.get('units',[]);ids=[u['unit_id'] for u in units]
    if not units or len(ids)!=len(set(ids)): raise ValueError('nonempty unique course units required')
    for u in units:
        if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*',u['unit_id']): raise ValueError('invalid unit ID')
        if not u.get('title') or not u.get('objective'): raise ValueError('unit title/objective required')
        if u.get('kind','概念') not in ('概念','实操','实验') or any(p not in ids for p in u.get('prerequisites',[])): raise ValueError('invalid original course kind/prerequisites')
        for ref in u.get('source_refs',[]): resolve(s,ref)
    with locked(s):
        path=Path(s)/'course-manifest.json';old=read_json(path)
        complete=read_json(Path(s)/'course-import-complete.json')
        if old==manifest and complete and (Path(s)/'curriculum.yaml').is_file() and complete.get('manifest_hash')==digest(manifest) and complete.get('curriculum_hash')==file_digest(Path(s)/'curriculum.yaml'): return {'changed':False}
        diff={'added':[i for i in ids if not old or i not in [u['unit_id'] for u in old['units']]],'removed':[u['unit_id'] for u in (old or {}).get('units',[]) if u['unit_id'] not in ids],'changed':[u['unit_id'] for u in units if old and any(o['unit_id']==u['unit_id'] and digest(o)!=digest(u) for o in old['units'])]}
        if old and old!=manifest and not accept_changes: return {'changed':False,'requires_accept_changes':True,'diff':diff}
        cur=read_yaml(Path(s)/'curriculum.yaml',{}) or {}
        if not old and cur.get('nodes') and not accept_changes: return {'changed':False,'requires_accept_changes':True,'diff':diff}
        if old: immutable(Path(s)/'course-history'/(digest(old)+'.json'),old)
        previous={n['id']:n for n in cur.get('nodes',[])};nodes=[]
        for unit in units:
            nid=unit['unit_id'];n=previous.get(nid,{'id':nid,'prerequisites':[],'status':'未开始','kind':'概念'})
            n.update(title=unit['title'],objective=unit['objective'],unit_id=nid,source_refs=unit.get('source_refs',[]),assignments=unit.get('assignments',[]))
            if 'kind' in unit: n['kind']=unit['kind']
            if 'prerequisites' in unit: n['prerequisites']=unit['prerequisites']
            nodes.append(n)
        new={'course_mode':manifest['course_mode'],'nodes':nodes,'edges':[e for e in cur.get('edges',[]) if e['from'] in ids and e['to'] in ids]}
        write_json(path,manifest);write_yaml(Path(s)/'curriculum.yaml',new)
        write_json(Path(s)/'course-import-complete.json',{'manifest_hash':digest(manifest),'curriculum_hash':file_digest(Path(s)/'curriculum.yaml')})
        return {'changed':True,'diff':diff}
def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--subject',required=True);p.add_argument('--input',required=True);p.add_argument('--accept-changes',action='store_true');a=p.parse_args()
    print(json.dumps(apply_course(subject_path(a.workspace,a.subject),read_json(a.input),a.accept_changes),ensure_ascii=False,indent=2))
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError) as e: print(str(e),file=sys.stderr);sys.exit(2)
