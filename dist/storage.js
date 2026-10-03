'use strict';
// One atomic library transaction. The original v1 key is never changed.
window.VoyzStorage = (() => {
  let FALLBACK='voyz.library.v2', EMERGENCY='voyz.emergency.v2', dbName='voyz-tour-board';
  let db, revision=0, chain=Promise.resolve(), lastBackup=0, mode='indexeddb';
  function open(){return new Promise((resolve,reject)=>{const r=indexedDB.open(dbName,2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('library'))r.result.createObjectStore('library');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Закройте другие вкладки Voyz и обновите страницу.'));});}
  function read(key){return new Promise((resolve,reject)=>{const t=db.transaction('library'),r=t.objectStore('library').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  function parse(key){const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;}
  async function init(namespace=''){
    if(namespace&&!/^[a-zA-Z0-9-]{1,100}$/.test(namespace))throw new Error('Некорректное пространство сохранения.');
    await chain.catch(()=>{});db?.close();db=null;revision=0;lastBackup=0;mode='indexeddb';
    const suffix=namespace?'.'+namespace:'';dbName='voyz-tour-board'+suffix;FALLBACK='voyz.library.v2'+suffix;EMERGENCY='voyz.emergency.v2'+suffix;
    let current,promoted=false;
    try{db=await open();db.onversionchange=()=>db.close();current=await read('current');if(!current){const fallback=parse(FALLBACK);if(fallback?.data){current={revision:0,savedAt:fallback.savedAt,data:fallback.data};promoted=true;}}}
    catch{mode='localStorage';current=parse(FALLBACK);}
    revision=current?.revision||0;
    let emergency;try{emergency=parse(EMERGENCY);}catch{}
    // An emergency checkpoint is only newer if based on the same committed revision.
    if(emergency&&emergency.baseRevision===revision&&emergency.time>(current?.savedAt||0))return {data:emergency.data,recovered:true,mode};
    return {data:current?.data||null,recovered:promoted,mode};
  }
  function checkpoint(data){try{localStorage.setItem(EMERGENCY,JSON.stringify({baseRevision:revision,time:Date.now(),data}));return true;}catch{return false;}}
  function save(data){
    const snapshot=structuredClone(data);
    const job=chain.catch(()=>{}).then(async()=>{
      const next={revision:revision+1,savedAt:Date.now(),data:snapshot};
      if(mode==='localStorage'){
        const prev=parse(FALLBACK);if((prev?.revision||0)!==revision)throw new Error('CONFLICT');
        // setItem is atomic: a quota error leaves the previous save intact.
        localStorage.setItem(FALLBACK,JSON.stringify(next));
      }else await new Promise((resolve,reject)=>{
        const t=db.transaction('library','readwrite'),store=t.objectStore('library'),r=store.get('current');let conflict=false;
        r.onsuccess=()=>{const prev=r.result;if((prev?.revision||0)!==revision){conflict=true;t.abort();return;}if(prev&&Date.now()-lastBackup>30000){store.put(prev,'previous');lastBackup=Date.now();}store.put(next,'current');};
        t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(new Error(conflict?'CONFLICT':'Не удалось завершить сохранение'));
      });
      revision=next.revision;
      try{const e=parse(EMERGENCY);if(e&&e.time<=next.savedAt)localStorage.removeItem(EMERGENCY);}catch{}
      return {revision,mode};
    });chain=job;return job;
  }
  async function previous(){return db?(await read('previous'))?.data:null;}
  return {init,save,checkpoint,previous};
})();
