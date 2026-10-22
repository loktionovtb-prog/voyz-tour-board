'use strict';
(() => {
 if(new URLSearchParams(location.hash.slice(1)).has('share'))return;
 const params=new URLSearchParams(location.search),wanted=params.get('tour');let selected=false;
 function select(){if(!window.VoyzBoard?.getLibrary)return;const b=VoyzBoard.getLibrary();if(!selected&&wanted&&b.tours.some(t=>t.id===wanted)){VoyzBoard.selectTour(wanted,params.get('view'));selected=true;}const active=b.tours.find(t=>t.id===b.activeTourId);document.querySelectorAll('[data-workspace-budget]').forEach(a=>a.href='budget.html?project='+encodeURIComponent(active?.id||''));}
 document.addEventListener('voyz-cloud-status',e=>{const detail=e.detail,el=document.querySelector('#workspace-cloud-status');if(el){el.textContent=detail.saved?'Сохранено онлайн':detail.error?'Онлайн: требуется внимание':detail.account?'Синхронизация аккаунта…':'Локальная копия · войдите для онлайн-сохранения';el.title=detail.message;}if(detail.saved)select();});
 document.addEventListener('voyz-local-saved',select);
 function boot(){select();if(location.protocol==='file:'){const box=document.createElement('div');box.style.cssText='padding:14px;background:#fff0bc;color:#503b0b;position:relative;z-index:20;font:14px Segoe UI';box.textContent='Это локальная копия. Чтобы продолжить на другом устройстве, сохраните бэкап и перенесите его в онлайн-аккаунт. ';const backup=document.createElement('button');backup.textContent='Скачать все туры';backup.onclick=()=>document.querySelector('#backup-btn').click();const link=document.createElement('a');link.href=window.VOYZ_CLOUD.publicUrl;link.textContent=' Открыть онлайн-пространство ↗';box.append(backup,link);document.body.prepend(box);}}
 if(window.VoyzBoard?.getLibrary)boot();else document.addEventListener('voyz-ready',boot,{once:true});
})();
