import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const __dirname=new URL('.',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const target=path.join(__dirname,'../../templates/assets/learning-records.js');
test('first answers survive changes and reopening, new rounds preserve history',()=>{
 assert.ok(fs.existsSync(target),'recording module missing');
 const api=require(target);const data=new Map();const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
 const meta={workspace_id:'w',subject:'s',node_id:'n'},q={question_id:'q',question_version:'v',ans:1};
 let a=api.create(meta,storage);a.answer(q,0);a.answer(q,1);
 a=api.create(meta,storage);assert.equal(a.get(q).attempts[0].answer,0);assert.equal(a.get(q).attempts.length,2);
 const p=a.exportPayload();assert.equal(p.records.length,1);assert.equal(a.exportPayload().export_id,p.export_id);
 a.newRound();a.answer(q,1);assert.equal(a.exportPayload().records[0].attempts[0].answer,1);
 assert.equal(a.history().length,2);
});
test('blocked storage still permits export',()=>{
 assert.ok(fs.existsSync(target));const api=require(target);
 const a=api.create({workspace_id:'w',subject:'s',node_id:'n'},{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}});
 a.answer({question_id:'q',question_version:'v'},'hello');
 assert.equal(a.available,false);assert.equal(a.exportPayload().records[0].attempts[0].answer,'hello');
});
test('unexported old rounds are included in the next export',()=>{
 const api=require(target),data=new Map(),a=api.create({workspace_id:'w',subject:'s',node_id:'n'},{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)});
 const q={question_id:'q',question_version:'v'};a.answer(q,'first');a.newRound();a.answer(q,'second');
 assert.equal(a.exportPayload().records.length,2);
});
test('blocked storage UI cannot reload and discard unexported answers',()=>{
 const api=require(target);let bar,reloaded=false;
 const element=()=>({children:[],appendChild(e){this.children.push(e);},addEventListener(k,f){this[k]=f;}});
 globalThis.window={localStorage:{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}};
 globalThis.document={createElement:element,querySelector(){return null;},body:{prepend(e){bar=e;}}};
 globalThis.location={reload(){reloaded=true;}};
 const a=api.mount({workspace_id:'w',subject:'s',node_id:'n'});a.answer({question_id:'q',question_version:'v'},'unexported');bar.children[1].click();
 assert.equal(reloaded,false);assert.equal(a.exportPayload().records[0].attempts[0].answer,'unexported');
 delete globalThis.window;delete globalThis.document;delete globalThis.location;
});
