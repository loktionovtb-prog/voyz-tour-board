'use strict';
(function(root){
  class BudgetStore {
    constructor({validate,write,storage,onChange=()=>{}}){this.validate=validate;this.write=write;this.storage=storage;this.onChange=onChange;this.records=new Map();this.activeId=null;this.owner=null;this.timers=new Map();}
    namespace(owner){return 'voyz.budgets.v2.'+owner;}
    emit(){this.onChange(this);}
    get active(){return this.records.get(this.activeId);}
    persist(){if(!this.owner)return;try{this.storage?.setItem(this.namespace(this.owner),JSON.stringify({activeId:this.activeId,records:[...this.records.values()].map(({document,revision,dirty,edits,error})=>({document,revision,dirty,edits,error}))}));}catch{this.cacheError='Не удалось записать аварийную копию. Скачайте бэкап.';}}
    open(owner,rows,requested,offline=false){
      for(const t of this.timers.values())clearTimeout(t);this.timers.clear();this.owner=owner;this.records.clear();this.activeId=null;
      let saved;try{saved=JSON.parse(this.storage?.getItem(this.namespace(owner))||'null');}catch{}
      for(const row of rows)this.records.set(row.id,{document:this.validate(row.document),revision:row.revision,dirty:false,edits:0,error:'',pending:null});
      for(const r of saved?.records||[]){if(!r.dirty&&!offline)continue;try{const doc=this.validate(r.document),online=this.records.get(doc.id);this.records.set(doc.id,{...r,document:doc,error:online&&online.revision!==r.revision?'Конфликт версий: сохраните отдельную копию.':r.error||'',pending:null});}catch{}}
      const wanted=requested||saved?.activeId;this.activeId=this.records.has(wanted)&&(requested||!this.records.get(wanted).document.deletedAt)?wanted:[...this.records.values()].find(r=>!r.document.deletedAt)?.document.id||null;this.persist();this.emit();
    }
    refresh(rows){for(const row of rows){const local=this.records.get(row.id);if(!local?.dirty&&!local?.pending)this.records.set(row.id,{document:this.validate(row.document),revision:row.revision,dirty:false,edits:0,error:'',pending:null});}this.persist();this.emit();}
    add(document){const doc=this.validate(document);if(this.records.has(doc.id))throw Error('Такая смета уже существует.');this.records.set(doc.id,{document:doc,revision:0,dirty:true,edits:1,error:'',pending:null});this.activeId=doc.id;this.persist();this.emit();this.schedule(doc.id);return doc;}
    select(id){if(!this.records.has(id))throw Error('Смета не найдена.');this.activeId=id;this.persist();this.emit();}
    edit(mutator,id=this.activeId){const r=this.records.get(id);if(!r)throw Error('Выберите смету.');const copy=structuredClone(r.document);mutator(copy);r.document=this.validate(copy);r.edits++;r.dirty=true;r.error='';this.persist();this.emit();this.schedule(id);}
    schedule(id){clearTimeout(this.timers.get(id));if(this.owner&&this.owner!=='guest')this.timers.set(id,setTimeout(()=>this.flush(id),650));}
    async flush(id=this.activeId){
      const r=this.records.get(id);if(!r)return false;clearTimeout(this.timers.get(id));if(r.pending){await r.pending;return r.dirty&&!r.error?this.flush(id):!r.dirty;}if(!r.dirty)return true;if(!this.owner||this.owner==='guest'){r.error='Войдите для сохранения онлайн.';this.emit();return false;}if(r.error.includes('Конфликт'))return false;
      const owner=this.owner,edits=r.edits,document=structuredClone(r.document),expected=r.revision;
      r.pending=(async()=>{try{const data=await this.write(id,expected,document);if(this.owner!==owner)return false;r.revision=data.revision;r.savedAt=data.updated_at||new Date().toISOString();if(r.edits===edits)r.dirty=false;r.error='';return true;}catch(e){if(this.owner===owner)r.error=/REVISION_CONFLICT/.test(e.message)?'Конфликт версий: сохраните отдельную копию.':e.message||'Не удалось сохранить онлайн.';return false;}finally{r.pending=null;if(this.owner===owner){this.persist();this.emit();if(r.dirty&&!r.error)this.schedule(id);}}})();this.emit();return r.pending;
    }
    async flushAll(){const results=await Promise.all([...this.records.keys()].map(id=>this.flush(id)));return results.every(Boolean);}
    documents(){return [...this.records.values()].map(r=>r.document);}
  }
  if(typeof module!=='undefined')module.exports=BudgetStore;else root.VoyzBudgetStore=BudgetStore;
})(typeof window==='undefined'?globalThis:window);
