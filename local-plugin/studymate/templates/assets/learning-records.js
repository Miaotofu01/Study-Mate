/* Shared answer archive. Browser storage is recovery only; Python imports are authoritative. */
(function(root,factory){var api=factory();if(typeof module==='object')module.exports=api;else root.LearningRecords=api;})(typeof window!=='undefined'?window:globalThis,function(){
 function id(){return globalThis.crypto.randomUUID();}
 function clone(v){return JSON.parse(JSON.stringify(v));}
 function create(meta,storage){
  var key='studymate.answers.v1:'+meta.workspace_id+':'+meta.subject+':'+meta.node_id,available=true,data;
  try{data=JSON.parse(storage.getItem(key)||'null');}catch(e){available=false;}
  if(!data)data={rounds:[{id:id(),records:{},sealed:false}],lastExport:null};
  function round(){return data.rounds[data.rounds.length-1];}
  function save(){try{storage.setItem(key,JSON.stringify(data));}catch(e){available=false;}}
  function entry(q){var k=q.question_id+':'+q.question_version,r=round();if(!r.records[k])r.records[k]={record_id:id(),round_id:r.id,node_id:q.node_id||meta.node_id,question_id:q.question_id,question_version:q.question_version,attempts:[]};return r.records[k];}
  return {
   get available(){return available;},meta:meta,
   get:function(q){return clone(entry(q));},
   draft:function(q,text){if(!round().sealed){entry(q).draft=text;save();}},
   answer:function(q,answer,forgot,help){if(round().sealed)throw Error('本轮已导出，请开始新一轮练习');
    var e=entry(q),a={answer:answer,forgot:!!forgot,answered_at:new Date().toISOString(),help:help||{}};
    if(e.answer_revealed_at)a.answer_revealed_at=e.answer_revealed_at;
    e.attempts.push(a);delete e.draft;save();return clone(e);},
   reveal:function(q){var e=entry(q);if(!round().sealed&&!e.answer_revealed_at){e.answer_revealed_at=new Date().toISOString();save();}},
   rate:function(q,event){if(round().sealed)throw Error('本轮已导出');var e=entry(q);if(e.fsrs)throw Error('本轮已评分，更正请使用 correct');e.fsrs=clone(event);save();},
   newRound:function(){round().closed=true;data.rounds.push({id:id(),records:{},sealed:false});save();},
   history:function(){return clone(data.rounds);},
   exportPayload:function(){var r=round(),pending=data.rounds.filter(function(x){return !x.sealed;}),records=pending.flatMap(function(x){return Object.values(x.records).filter(function(e){return e.attempts.length;});});
    if(!records.length){if(data.lastExport)return clone(data.lastExport);throw Error('尚无作答');}
    if(!r.sealed){pending.forEach(function(x){x.sealed=true;});data.lastExport={schema_version:1,workspace_id:meta.workspace_id,subject:meta.subject,export_id:id(),exported_at:new Date().toISOString(),records:clone(records)};save();}
    return clone(data.lastExport);},
   download:function(){var payload=this.exportPayload(),blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}),a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download='studymate-answers-'+meta.subject+'-'+payload.export_id+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);}
  };
 }
 function mount(meta){
  var storage;try{storage=window.localStorage;}catch(e){storage={getItem:function(){throw e;},setItem:function(){throw e;}};}
  var store=create(meta,storage),bar=document.createElement('div');bar.className='learning-record-controls';
  var status=document.createElement('p');
  function refresh(){status.textContent=store.available?'页面已缓存；导出并导入后进入正式档案。':'当前浏览器无法保存，请导出记录';}
  ['导出作答记录','开始新一轮练习'].forEach(function(label,i){var b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',function(){try{if(i){if(!store.available&&store.history().some(function(r){return !r.sealed&&Object.values(r.records).some(function(e){return e.attempts.length;});}))throw Error('缓存不可用，请先导出作答记录，再开始新一轮');store.newRound();location.reload();}else store.download();refresh();}catch(e){status.textContent=e.message;}});bar.appendChild(b);});
  bar.appendChild(status);(document.querySelector('article')||document.body).prepend(bar);refresh();return store;
 }
 return {create:create,mount:mount};
});
