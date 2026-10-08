"""Run the local distribution checks without touching real learning data."""
import ast,json,shutil,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def run(args):
    result=subprocess.run(args,cwd=root)
    if result.returncode: raise SystemExit(result.returncode)
for p in (root/'scripts').rglob('*.py'): ast.parse(p.read_text(encoding='utf-8-sig'),filename=str(p))
for p in (root/'schemas').glob('*.json'):
    import jsonschema
    jsonschema.Draft7Validator.check_schema(json.loads(p.read_text(encoding='utf-8')))
run([sys.executable,'-X','utf8','-B','-m','unittest','discover','-s','scripts/tests','-v'])
node=shutil.which('node')
if not node: raise SystemExit('Node.js is required for the browser-module development tests')
run([node,'--test','scripts/tests/test_recording_ui.mjs'])
skills=[str(p) for p in sorted((root/'skills').iterdir()) if (p/'SKILL.md').is_file()]
run([sys.executable,'-X','utf8','-B','scripts/check_skill.py',*skills])
for p in (root/'templates/assets').glob('*.js'): run([node,'--check',str(p)])
print('QA passed: Python, Node, schemas, skills and JavaScript syntax.')

