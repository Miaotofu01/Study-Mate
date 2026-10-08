"""Explicit workspace setup, non-destructive migration and scoped stage cleanup."""
import argparse,json,re,shutil,sys,zipfile
from pathlib import Path
from data_store import *
from quiz_identity import workspace_id,prepare_quiz
from interaction_state import workspace_path
def component(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value) or value in ('.','..'): raise ValueError('invalid stage/session component')
    return value
def stage(s,session_id,task):
    p=safe_path(Path(s)/'.stage'/component(session_id)/component(task))
    if Path(s).resolve().is_relative_to(Path(__file__).resolve().parents[1]): raise ValueError('stage must be outside plugin')
    for a in (p,p.parent,p.parent.parent,Path(s)):
        if a.is_symlink(): raise ValueError('symlink stage')
    p.mkdir(parents=True,exist_ok=True);return p
def clean_stage(s,session_id,task):
    s=safe_path(s).resolve();p=safe_path(s/'.stage'/component(session_id)/component(task))
    if not p.resolve().is_relative_to(s/'.stage') or any(a.is_symlink() for a in (p,p.parent,p.parent.parent)): raise ValueError('unsafe stage target')
    if p.exists(): shutil.rmtree(p)
def migrate(workspace):
    ws=workspace_path(workspace);marker=ws/'.learning/migration-v1.json'
    if marker.exists(): return {'migrated':False,'report':read_json(marker)}
    # Backup before the first identity/catalog write; do not fabricate review events.
    with locked(ws/'.learning','.migration.lock'):
        backup=ws/'studymate-backups'/('before-migration-'+now().replace(':','-')+'.zip');backup.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(backup,'w',zipfile.ZIP_DEFLATED) as z:
            for p in (ws/'.learning').rglob('*'):
                if p.is_file() and not p.is_symlink() and not p.name.endswith('.lock'): z.write(p,p.relative_to(ws))
        wid=workspace_id(ws);count=0
        for s in (ws/'.learning/subjects').iterdir():
            if not s.is_dir() or s.is_symlink(): continue
            for quiz in (s/'lessons').glob('*.quiz.json'):
                stem=quiz.name[:-10];node=stem.split('-',1)[1] if '-' in stem else stem
                prepare_quiz(s,node,read_json(quiz));count+=1
        report={'schema_version':1,'workspace_id':wid,'migrated_at':now(),'backup':str(backup),'cataloged_quizzes':count,'legacy_states':'preserved_unverified','fsrs_events_created':0}
        write_json(marker,report);return {'migrated':True,'report':report}
def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True)
    sub=p.add_subparsers(dest='cmd',required=True)
    sub.add_parser('migrate')
    q=sub.add_parser('init');q.add_argument('--config',help='explicit persistent config destination')
    for name in ('stage','clean-stage'):
        q=sub.add_parser(name);q.add_argument('--subject',required=True);q.add_argument('--session-id',required=True);q.add_argument('--task',required=True)
    a=p.parse_args();ws=Path(a.workspace)
    if a.cmd=='init':
        if not ws.is_absolute(): raise ValueError('absolute workspace required')
        if ws.resolve().is_relative_to(Path(__file__).resolve().parents[1]): raise ValueError('workspace must be outside plugin')
        safe_path(ws/'.learning/subjects').mkdir(parents=True,exist_ok=True);workspace_path(ws);result={'workspace_id':workspace_id(ws)}
        if a.config:
            config=Path(a.config).expanduser()
            existing=read_yaml(config,{}) or {};existing['workspace']=str(ws);write_yaml(config,existing);result['config']=str(config)
    elif a.cmd=='migrate': result=migrate(ws)
    else:
        s=subject_path(ws,a.subject)
        if a.cmd=='stage': result={'stage':str(stage(s,a.session_id,a.task))}
        else: clean_stage(s,a.session_id,a.task);result={'cleaned':True}
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError) as e: print(str(e),file=sys.stderr);sys.exit(2)
