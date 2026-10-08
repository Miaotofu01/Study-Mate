"""Shared atomic storage for the learning workspace (no plugin data writes)."""
import contextlib, hashlib, json, os, re, tempfile
from datetime import datetime, timezone
from pathlib import Path
import yaml
import stat

def reparse(path):
    try: return bool(getattr(Path(path).lstat(),'st_file_attributes',0) & getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',1024)) or Path(path).is_symlink()
    except FileNotFoundError: return False
def safe_path(path):
    p=Path(path)
    if any(reparse(a) for a in (p,*p.parents)): raise ValueError('refusing symlink/junction/reparse path: '+str(p))
    return p

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()
def file_digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for block in iter(lambda:f.read(1048576),b''): h.update(block)
    return h.hexdigest()
def now():
    return datetime.now(timezone.utc).isoformat()
def utc(value):
    result=datetime.fromisoformat(value.replace('Z','+00:00')) if isinstance(value,str) else value
    if not isinstance(result,datetime) or result.tzinfo is None: raise ValueError('time must include a timezone')
    return result.astimezone(timezone.utc)
def read_json(path, default=None):
    p=safe_path(path)
    if not p.exists(): return default
    return json.loads(p.read_text(encoding='utf-8-sig'), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
def atomic_text(path,text):
    p=safe_path(path); p.parent.mkdir(parents=True,exist_ok=True)
    if p.is_symlink(): raise ValueError('refusing symlink: '+str(p))
    fd,name=tempfile.mkstemp(prefix='.'+p.name,dir=p.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8',newline='\n') as f:
            f.write(text);f.flush();os.fsync(f.fileno())
        os.replace(name,p)
    finally:
        if os.path.exists(name): os.unlink(name)
def write_json(path,value):
    atomic_text(path,json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def immutable(path,value):
    p=safe_path(path); p.parent.mkdir(parents=True,exist_ok=True)
    old=read_json(p)
    if old is not None:
        if digest(old)!=digest(value): raise ValueError('immutable ID conflict: '+p.name)
        return False
    # Exclusive create; complete file is published atomically while caller owns a lock.
    write_json(p,value);return True
@contextlib.contextmanager
def locked(directory,name='.studymate.lock'):
    directory=safe_path(directory);directory.mkdir(parents=True,exist_ok=True)
    lock=directory/name
    try: fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError: raise ValueError('workspace is busy: '+str(lock)) from None
    try:
        with os.fdopen(fd,'w') as f: f.write(str(os.getpid()))
        yield
    finally: lock.unlink(missing_ok=True)
def subject_path(workspace,subject):
    ws=Path(workspace).absolute()
    if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*',subject): raise ValueError('invalid subject slug')
    plugin=Path(__file__).resolve().parents[1]
    target=ws/'.learning'/'subjects'/subject
    if not (ws/'.learning').is_dir() or not target.is_dir(): raise ValueError('subject/workspace does not exist')
    if target.resolve().is_relative_to(plugin): raise ValueError('learning data must be outside the engine')
    for p in [ws,ws/'.learning',ws/'.learning'/'subjects',target]:
        safe_path(p)
    if not target.resolve().is_relative_to(ws.resolve()/'.learning'/'subjects'): raise ValueError('subject escaped workspace')
    return target
def read_yaml(path,default=None):
    p=safe_path(path)
    return yaml.safe_load(p.read_text(encoding='utf-8-sig')) if p.exists() else default
def write_yaml(path,value):
    atomic_text(path,yaml.safe_dump(value,allow_unicode=True,sort_keys=False))
