'use strict';
window.VoyzExport = (() => {
  const W=1200,M=72,CONTENT=W-M*2;
  const safeName=s=>(s||'Voyz').replace(/[^\p{L}\p{N} _-]/gu,'').trim().slice(0,80)||'Voyz';
  function load(src){return new Promise((resolve,reject)=>{if(!src){resolve(null);return;}const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Не удалось прочитать фотографию для экспорта.'));i.src=src;});}
  function wrap(ctx,text,width){const lines=[];for(const para of String(text||'').split('\n')){if(!para){lines.push('');continue;}let line='';for(const word of para.split(/\s+/)){const test=line?line+' '+word:word;if(ctx.measureText(test).width<=width){line=test;continue;}if(line){lines.push(line);line='';}if(ctx.measureText(word).width<=width){line=word;continue;}for(const char of word){if(ctx.measureText(line+char).width>width){lines.push(line);line='';}line+=char;}}lines.push(line);}return lines;}
  function font(size,bold=false){return (bold?'600 ':'400 ')+size+'px "Segoe UI", Arial, sans-serif';}
  function date(t,i){if(!t.tour.startDate)return 'Даты уточняются';const d=new Date(t.tour.startDate+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});}
  async function layout(t,d,index){
    const measure=document.createElement('canvas').getContext('2d'),ops=[];
    const text=(s,size=30,bold=false,color='#25443c',gap=18,bg=null)=>{measure.font=font(size,bold);const lines=wrap(measure,s,CONTENT-(bg?36:0));for(const line of lines)ops.push({type:'line',text:line,size,bold,color,height:Math.ceil(size*1.5),bg});ops.push({type:'gap',height:gap});};
    text(t.tour.title||'Путешествие Voyz',25,false,'#738476',12);
    text('ДЕНЬ '+String(index+1).padStart(2,'0')+'  /  '+date(t,index),23,true,'#58703c',22);
    text(d.title||'Новый день',48,true,'#193c32',25);
    const photo=await load(d.photo);if(photo){ops.push({type:'image',image:photo,height:340});if(d.photoCredit)text(d.photoCredit+' · фото кадрировано',17,false,'#7b877b',18);else ops.push({type:'gap',height:24});}
    if(d.description)text(d.description,30,false,'#596f63',25);
    if(d.lodgingName||d.lodgingUrl){text('ПРОЖИВАНИЕ',22,true,'#748653',10);if(d.lodgingName)text(d.lodgingName,28,false,'#25443c',8);if(d.lodgingUrl){let link='';try{const u=new URL(/^https?:\/\//i.test(d.lodgingUrl)?d.lodgingUrl:'https://'+d.lodgingUrl);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.hostname.includes('.'))link=u.href;}catch{}const start=ops.length;text(d.lodgingUrl,22,false,'#597d3b',20);if(link)ops.slice(start).filter(o=>o.type==='line').forEach(o=>o.link=link);}}
    text('ПЛАН ДНЯ',22,true,'#748653',12);
    if(!d.schedule.length)text('План пока не заполнен',28,false,'#869380',25);
    d.schedule.forEach(r=>text((r.time?r.time+'  ·  ':'')+(r.text||'Событие'),30,false,'#213e35',12));
    for(const [label,value,bg] of [[d.noteTitle||'Заметки',d.note,'#f0f5e4'],[d.planBTitle||'Заметки 2',d.planB,'#f7f2e9']]){if(!value)continue;ops.push({type:'gap',height:20});text(label,23,true,'#668149',10);text(value,28,false,'#506350',20,bg);}
    if(d.photoCredit)text('Источники фото и лицензии: Wikimedia Commons; подробности в credits.html проекта.',16,false,'#889180',0);
    return ops;
  }
  function partition(ops,capacity){const pages=[];let group=[],used=0;for(const op of ops){if(group.length&&used+op.height>capacity){pages.push(group);group=[];used=0;}group.push(op);used+=op.height;}if(group.length)pages.push(group);return pages;}
  function draw(ops,height,logo,pageLabel){const c=document.createElement('canvas');c.width=W;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,height);ctx.fillStyle='#d9f500';ctx.fillRect(0,0,W,12);if(logo)ctx.drawImage(logo,M,37,205,55);ctx.fillStyle='#879178';ctx.font=font(18);ctx.fillText('TRAVEL NOTES',W-M-160,72);ctx.strokeStyle='#dce5d6';ctx.beginPath();ctx.moveTo(M,112);ctx.lineTo(W-M,112);ctx.stroke();let y=151;for(const op of ops){if(op.type==='line'){if(op.bg){ctx.fillStyle=op.bg;ctx.fillRect(M-12,y-5,CONTENT+24,op.height+7);}ctx.fillStyle=op.color;ctx.font=font(op.size,op.bold);ctx.textBaseline='top';ctx.fillText(op.text,M+(op.bg?6:0),y);}if(op.type==='image'){const im=op.image,ratio=Math.max(CONTENT/im.width,op.height/im.height),sw=CONTENT/ratio,sh=op.height/ratio;ctx.drawImage(im,(im.width-sw)/2,(im.height-sh)/2,sw,sh,M,y,CONTENT,op.height);}y+=op.height;}ctx.fillStyle='#879178';ctx.font=font(18);ctx.textBaseline='alphabetic';ctx.fillText(pageLabel,M,height-38);ctx.textAlign='right';ctx.fillText('VOYZ · маршрут для путешествия',W-M,height-38);return c;}
  function preview(c){const p=document.createElement('canvas');p.width=360;p.height=Math.round(c.height*360/c.width);p.getContext('2d').drawImage(c,0,0,p.width,p.height);return p.toDataURL('image/jpeg',.8);}
  function annotateLinks(doc,page,ops){let y=151;const sx=595.28/W,sy=841.89/1697,refs=[];for(const op of ops){if(op.link){const annotation=doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[M*sx,841.89-(y+op.height)*sy,(W-M)*sx,841.89-y*sy],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFLib.PDFString.of(op.link)}});refs.push(doc.context.register(annotation));}y+=op.height;}if(refs.length)page.node.set(PDFLib.PDFName.of('Annots'),doc.context.obj(refs));}
  async function pdf(t,progress){
    if(!window.PDFLib)throw new Error('Библиотека PDF не загрузилась. Обновите страницу.');
    const doc=await PDFLib.PDFDocument.create(),logo=await load(window.VOYZ_LOGO),previews=[];let total=0;
    doc.setTitle(t.tour.title||'Voyz Tour');doc.setCreator('Voyz Tour Board');doc.setProducer('Voyz Tour Board / pdf-lib');
    for(let i=0;i<t.days.length;i++){const groups=partition(await layout(t,t.days[i],i),1697-240);for(let p=0;p<groups.length;p++){if(++total>300)throw new Error('Маршрут слишком большой для одного PDF (более 300 страниц).');const c=draw(groups[p],1697,logo,'День '+(i+1)+(groups.length>1?' · часть '+(p+1)+'/'+groups.length:''));const embedded=await doc.embedJpg(c.toDataURL('image/jpeg',.92));const page=doc.addPage([595.28,841.89]);page.drawImage(embedded,{x:0,y:0,width:595.28,height:841.89});annotateLinks(doc,page,groups[p]);if(previews.length<12)previews.push(preview(c));c.width=1;c.height=1;}progress?.('Готовим PDF: день '+(i+1)+' из '+t.days.length);await new Promise(r=>setTimeout(r,0));}
    const data=await doc.saveAsBase64({dataUri:true});return {files:[{name:safeName(t.tour.title)+'.pdf',url:data}],previews,summary:total+' стр. · все дни маршрута · без данных клиентов'};
  }
  async function dayImage(t,id,type){const i=t.days.findIndex(d=>d.id===id),d=t.days[i];if(!d)throw new Error('День не найден.');const logo=await load(window.VOYZ_LOGO),ops=await layout(t,d,i),groups=partition(ops,11000),files=[],previews=[];
    for(let p=0;p<groups.length;p++){const height=Math.max(700,groups[p].reduce((n,o)=>n+o.height,0)+245),c=draw(groups[p],height,logo,'День '+(i+1)+(groups.length>1?' · часть '+(p+1)+'/'+groups.length:''));files.push({name:safeName('День '+(i+1)+' '+(d.title||'Voyz'))+(groups.length>1?' - '+(p+1):'')+'.'+type,url:c.toDataURL(type==='png'?'image/png':'image/jpeg',.94)});previews.push(preview(c));c.width=1;c.height=1;}
    return {files,previews,summary:files.length===1?'Один день целиком · удобно сохранить в галерею':'Длинный день разделён на '+files.length+' изображений без обрезки текста'};
  }
  return {pdf,dayImage};
})();


