"""Read-only sources, immutable extracted versions, rebuildable keyword index."""
import argparse,json,re,sqlite3,sys,uuid,zipfile,posixpath
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.parse import urlsplit,urljoin
from xml.etree import ElementTree as ET
from data_store import *
EXTENSIONS={'.pdf','.epub','.md','.txt','.html','.htm','.srt','.vtt'}
def sources(s): return read_json(Path(s)/'sources/manifest.json',{'schema_version':1,'sources':[]})['sources']
def chunk(text,locator,title=''):
    return {'text':text.strip(),'locator':locator,'title':title}
def pdf_status(page,text):
    if not text.strip(): return 'needs_ocr'
    fonts=page.get('/Resources',{}).get('/Font',{})
    for value in fonts.values():
        font=value.get_object()
        if font.get('/Subtype')=='/Type0' and font.get('/Encoding') in ('/Identity-H','/Identity-V') and not font.get('/ToUnicode'):
            return 'needs_unicode_mapping_or_ocr'
    return 'ready'
def html_chunks(text,base=''):
    from bs4 import BeautifulSoup
    soup=BeautifulSoup(text,'html.parser')
    for tag in soup(['script','style','nav']): tag.decompose()
    result=[];heading='document';anchor='';buf=[]
    for tag in soup.find_all(['h1','h2','h3','h4','p','li','pre','td']):
        if tag.name.startswith('h'):
            if buf: result.append(chunk('\n'.join(buf),{'heading':heading,'anchor':anchor},heading));buf=[]
            heading=tag.get_text(' ',strip=True);anchor=tag.get('id','')
        else: buf.append(tag.get_text(' ',strip=True))
    if buf: result.append(chunk('\n'.join(buf),{'heading':heading,'anchor':anchor},heading))
    if not result: result=[chunk(soup.get_text(' ',strip=True),{'heading':'document'})]
    links=[{'title':a.get_text(' ',strip=True),'url':urljoin(base,a['href'])} for a in soup.find_all('a',href=True) if urlsplit(urljoin(base,a['href'])).scheme in ('http','https','file')]
    return result,links
def extract(path):
    p=Path(path);ext=p.suffix.lower();links=[]
    if ext=='.pdf':
        from pypdf import PdfReader
        reader=PdfReader(p);rows=[chunk(page.extract_text() or '',{'page':i+1}) for i,page in enumerate(reader.pages)]
        for row,page in zip(rows,reader.pages): row['status']=pdf_status(page,row['text'])
        status='ready' if all(r['status']=='ready' for r in rows) else 'partial_text' if any(r['status']=='ready' for r in rows) else 'needs_ocr'
        return rows,links,status
    if ext=='.epub':
        rows=[]
        with zipfile.ZipFile(p) as z:
            if sum(i.file_size for i in z.infolist())>268435456: raise ValueError('EPUB uncompressed size exceeds 256 MiB')
            container=ET.fromstring(z.read('META-INF/container.xml'));opf=next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
            root=ET.fromstring(z.read(opf));base=posixpath.dirname(opf)
            manifest={e.attrib['id']:e.attrib['href'] for e in root.iter() if e.tag.endswith('item') and 'href' in e.attrib}
            for i,e in enumerate(e for e in root.iter() if e.tag.endswith('itemref')):
                href=manifest[e.attrib['idref']];name=posixpath.normpath(posixpath.join(base,href))
                sections,_=html_chunks(z.read(name).decode('utf-8-sig'))
                for row in sections: row['locator'].update(spine_index=i,href=href)
                rows.extend(sections)
        return rows,links,'ready'
    text=p.read_text(encoding='utf-8-sig')
    if ext in ('.html','.htm'):
        rows,links=html_chunks(text,p.as_uri());return rows,links,'ready'
    if ext in ('.srt','.vtt'):
        rows=[]
        for block in re.split(r'\r?\n\s*\r?\n',text):
            m=re.search(r'((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]+)',block)
            if m: rows.append(chunk(m[3],{'timestamp':m[1].replace(',','.'),'end':m[2].replace(',','.')}))
        return rows,links,'ready' if rows else 'no_text'
    lines=text.splitlines();rows=[];start=1;heading='document';buf=[]
    for i,line in enumerate(lines,1):
        if re.match(r'^#{1,6}\s+',line) or len('\n'.join(buf))>4000:
            if buf: rows.append(chunk('\n'.join(buf),{'line_start':start,'line_end':i-1,'heading':heading},heading))
            buf=[];start=i
            if line.startswith('#'): heading=re.sub(r'^#+\s*','',line)
        buf.append(line)
    if buf: rows.append(chunk('\n'.join(buf),{'line_start':start,'line_end':len(lines),'heading':heading},heading))
    return rows,links,'ready'
def _save(s,entries):
    write_json(Path(s)/'sources/manifest.json',{'schema_version':1,'sources':entries});_rebuild(s,entries)
def _rebuild(s,entries=None):
    entries=entries if entries is not None else sources(s);p=safe_path(Path(s)/'sources/index.sqlite3');p.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(p)
    try:
        with db:
            db.execute('CREATE TABLE IF NOT EXISTS chunks (source_id TEXT,source_version TEXT,locator TEXT,title TEXT,text TEXT)')
            db.execute('DELETE FROM chunks')
            for entry in entries:
                for ver in entry.get('versions',[]):
                    data=read_json(Path(s)/'sources/versions'/entry['source_id']/(ver+'.json'))
                    for row in data.get('chunks',[]):
                        if row.get('status','ready')=='ready': db.execute('INSERT INTO chunks VALUES (?,?,?,?,?)',(entry['source_id'],ver,canonical(row['locator']),row['title'],row['text']))
    finally: db.close()
def _entry(s,entries,path,origin,root):
    ver=file_digest(path);entry=next((e for e in entries if e['origin']==origin),None)
    if entry and entry['source_version']==ver:
        entry['availability']='available';return False
    if not entry:
        candidates=[e for e in entries if e.get('root')==root and e['source_version']==ver and e.get('availability')=='missing']
        entry=candidates[0] if len(candidates)==1 else {'source_id':str(uuid.uuid4()),'versions':[]}
        if entry not in entries: entries.append(entry)
    try: chunks,links,status=extract(path);error=None
    except Exception as exc: chunks,links,status,error=[],[],'extract_failed',str(exc)
    immutable(Path(s)/'sources/versions'/entry['source_id']/(ver+'.json'),{'schema_version':1,'source_id':entry['source_id'],'source_version':ver,'chunks':chunks,'links':links,'status':status,'error':error})
    entry.update(origin=origin,root=root,title=Path(path).stem,format=Path(path).suffix.lower()[1:],source_version=ver,availability='available',extraction_status=status,error=error)
    if ver not in entry['versions']: entry['versions'].append(ver)
    return True
def scan(s,root):
    root=Path(root).resolve(strict=True);files=sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in EXTENSIONS and not p.is_symlink() and not any(a.is_symlink() for a in p.parents) and not any(part.startswith('.') or part in ('node_modules','__pycache__','venv','env','build','dist') for part in p.relative_to(root).parts))
    if not root.is_dir(): raise ValueError('source root must be a directory')
    with locked(s):
        entries=sources(s);origins={p.as_uri() for p in files}
        for e in entries:
            if e.get('root')==str(root) and e['origin'] not in origins: e['availability']='missing'
        changed=sum(_entry(s,entries,p,p.as_uri(),str(root)) for p in files);_save(s,entries)
        return {'scanned':len(files),'changed':changed,'sources':entries}
def fetch(s,url):
    parts=urlsplit(url)
    if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password: raise ValueError('public HTTP(S) URL required, without credentials')
    request=Request(url,headers={'User-Agent':'StudyMate-source-index/1.0'})
    with urlopen(request,timeout=30) as response:
        if urlsplit(response.url).scheme not in ('http','https'): raise ValueError('invalid redirect')
        if response.headers.get_content_type() not in ('text/html','application/xhtml+xml','text/plain'): raise ValueError('fetch supports public HTML/text; download binary documents separately and scan the selected folder')
        raw=response.read(16777217)
        if len(raw)>16777216: raise ValueError('page exceeds 16 MiB')
        charset=response.headers.get_content_charset() or 'utf-8';text=raw.decode(charset,errors='replace')
    with locked(s):
        entries=sources(s);ver=digest(text);entry=next((e for e in entries if e['origin']==url),None)
        if not entry: entry={'source_id':str(uuid.uuid4()),'versions':[]};entries.append(entry)
        rows,links=html_chunks(text,url)
        immutable(Path(s)/'sources/versions'/entry['source_id']/(ver+'.json'),{'schema_version':1,'source_id':entry['source_id'],'source_version':ver,'chunks':rows,'links':links,'status':'ready'})
        changed=entry.get('source_version')!=ver
        entry.update(origin=url,root=None,title=rows[0]['title'] if rows else url,format='html',source_version=ver,availability='available',extraction_status='ready')
        if ver not in entry['versions']: entry['versions'].append(ver)
        _save(s,entries);return {'changed':changed,'source':entry}
def search(s,query,limit=20):
    terms=query.split()
    if not terms: return []
    with locked(s):
        if not (Path(s)/'sources/index.sqlite3').exists(): _rebuild(s)
        db=sqlite3.connect(safe_path(Path(s)/'sources/index.sqlite3'))
        try:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise sqlite3.DatabaseError('corrupt source index')
        except sqlite3.DatabaseError:
            db.close();safe_path(Path(s)/'sources/index.sqlite3').unlink();_rebuild(s);db=sqlite3.connect(safe_path(Path(s)/'sources/index.sqlite3'))
        try:
            rows=db.execute('SELECT * FROM chunks WHERE '+' AND '.join('instr(lower(text),lower(?))>0' for _ in terms)+' LIMIT ?',(*terms,min(max(int(limit),1),100))).fetchall()
            entries={e['source_id']:e for e in sources(s)}
            return [dict(source_id=r[0],source_version=r[1],locator=json.loads(r[2]),title=r[3],excerpt=r[4][:1000],origin=entries[r[0]]['origin'],availability=entries[r[0]]['availability'],current=r[1]==entries[r[0]]['source_version']) for r in rows]
        finally: db.close()
def resolve(s,reference):
    if not re.fullmatch('[0-9a-f]{64}',reference['source_version']): raise ValueError('invalid source version')
    data=read_json(Path(s)/'sources/versions'/str(uuid.UUID(reference['source_id']))/(reference['source_version']+'.json'))
    if not data: raise ValueError('unknown source version')
    matches=[c for c in data['chunks'] if c['locator']==reference['locator']]
    if not matches: raise ValueError('unknown source locator')
    return matches
def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--subject',required=True)
    sub=p.add_subparsers(dest='cmd',required=True);q=sub.add_parser('scan');q.add_argument('root');q=sub.add_parser('fetch');q.add_argument('url');q=sub.add_parser('search');q.add_argument('query');sub.add_parser('rebuild')
    a=p.parse_args();s=subject_path(a.workspace,a.subject)
    if a.cmd=='scan': result=scan(s,a.root)
    elif a.cmd=='fetch': result=fetch(s,a.url)
    elif a.cmd=='search': result=search(s,a.query)
    else:
        with locked(s): _rebuild(s)
        result={'rebuilt':True}
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError) as e: print(str(e),file=sys.stderr);sys.exit(2)
