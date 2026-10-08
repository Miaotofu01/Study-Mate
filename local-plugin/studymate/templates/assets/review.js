/* Answer first, reveal, then export. Formal dates come from Python. */
(function(){
 function el(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
 var data=JSON.parse(document.getElementById('review-data').textContent),store=LearningRecords.mount(data.meta),root=document.getElementById('review-list');
 var parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 var today=['year','month','day'].map(function(k){return parts.find(function(p){return p.type===k;}).value;}).join('-');
 root.before(el('p','最近同步：'+new Date(data.synced_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})));
 data.items.filter(function(i){return i.review_count===0||i.due_date<=today;}).forEach(function(item){
  var q={question_id:item.question_id,question_version:item.question_version,node_id:item.node_id},section=el('section'),record=store.get(q);
  section.className='review-card';section.append(el('h2',item.prompt),el('p',item.review_count?'到期：'+item.due_date+' · 已复习 '+item.review_count+' 次':'首次复习'));
  var input=el('textarea');input.placeholder='先写下你的回忆';input.value=record.attempts.length?record.attempts[record.attempts.length-1].answer||'':record.draft||'';
  input.oninput=function(){store.draft(q,input.value);};section.append(input);
  var help=el('input');help.type='checkbox';var label=el('label','使用了提示、资料或 AI ');label.append(help);section.append(label);
  var note=el('p'),answer=el('div',item.answer+'\n判分要点：'+item.criteria);answer.style.whiteSpace='pre-wrap';answer.hidden=!record.answer_revealed_at;
  if(record.fsrs)note.textContent='本轮已评分，请确认导出已导入正式档案。';
  var reveal=el('button','保存作答并显示答案'),forgot=el('button','没想起'),ratings=el('div');
  function save(failed){try{record=store.get(q);if(!record.attempts.length){if(!failed&&!input.value.trim())throw Error('请先写下回忆，或选择没想起');store.answer(q,input.value,failed,{used_reference:help.checked});}
    store.reveal(q);record=store.get(q);answer.hidden=false;ratings.hidden=false;
   }catch(e){note.textContent=e.message;}}
  reveal.onclick=function(){save(false);};forgot.onclick=function(){save(true);};section.append(reveal,forgot,answer);
  ratings.hidden=!record.answer_revealed_at;
  ['没想起','费力想起','正常想起','轻松想起'].forEach(function(text,index){var b=el('button',text);b.onclick=function(){
   try{var r=store.get(q),a=r.attempts[0];if(!a)throw Error('请先作答');
    var independent=!a.help.used_reference&&!a.answer_revealed_at;
    if(a.forgot&&index!==0)throw Error('没想起应选第一项');
    store.rate(q,{event_id:crypto.randomUUID(),review_item_id:item.review_item_id,item_version:item.item_version,question_id:q.question_id,question_version:q.question_version,round_id:r.round_id,reviewed_at:a.answered_at,rating:index+1,answer:a.answer,forgot:a.forgot,help:a.help,independent_attempt:independent,answer_revealed_at:a.answer_revealed_at||null,rated_at:new Date().toISOString()});
    ratings.querySelectorAll('button').forEach(function(x){x.disabled=true;});note.textContent='已评分；导出并导入后计算下次日期。';
   }catch(e){note.textContent=e.message;}};b.disabled=!!record.fsrs;ratings.append(b);});
  section.append(ratings,note);root.append(section);
 });
 if(!root.children.length)root.append(el('p','今天没有到期复习项。'));
})();
