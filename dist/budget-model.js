'use strict';
(function(root){
  const uid=()=>globalThis.crypto.randomUUID();
  const n=v=>v===null||v===''||v===undefined?null:Number(v);
  const valid=v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e10;
  const round=v=>Math.round((v+Number.EPSILON)*100)/100;
  function seed(){
    const line=(name,basis,units,price,note='',category='Активности',extra=0,unitsMode='fixed')=>({id:uid(),name,category,basis,units,price,currency:'KGS',actual:null,note,extra,unitsMode});
    return {version:1,id:uid(),title:'Кыргызстан · июль 2027',settings:{guests:6,guides:2,days:8,nights:6,autoCars:true,currency:'KGS',rates:{USD:null,EUR:null,RUB:null},fx:null,salePrice:null,received:0,stage:'planning'},
      vehicles:['Машина 1','Машина 2'].map(name=>({id:uid(),name,count:1,days:8,rent:100,currency:'USD',km:null,consumption:null,fuelPrice:120,fuelCurrency:'KGS',actualRent:null,actualFuel:null})),
      lines:[...['Каракол','Алтын-Арашан','Южный берег','Нарын','Кок-Кыя / Кель-Суу','Сон-Куль'].map((place,i)=>({...line('Ночь '+(i+1)+' · '+place,'all',1,5000,'5 000 с человека за ночь, включая гидов. Завтрак включён.','Жильё'),night:true})),
        line('Питание гидов','guides',8,2000,'2 000 на гида в сутки; автоматически по числу гидов и дней.','Питание',0,'days'),
        line('Кони · Девичьи слёзы','guests',1,1500,'Кони гостей + 1 конь конюха по той же цене.','Активности',1),
        line('Кони · Алтын-Арашан / Ала-Куль','all',1,3500,'Гости и гиды + 1 конь конюха. Заброска своими джипами.','Активности',1),
        line('Кони · Кель-Суу','all',1,null,'Введите ставку, когда определитесь. Конь конюха уже добавлен.','Активности',1),
        line('Погранпропуск · Кель-Суу','all',1,3000,'3 000 с человека по данным организатора. Сейчас 8 человек; если гидам не нужен — выберите «Гости».','Сборы'),
        line('Каньон Сказка','guests',1,50,'Предварительно оплачивают 6 гостей.','Сборы'),
        line('Кок-Мойнок','guests',1,50,'Предварительно оплачивают 6 гостей.','Сборы'),
        line('Парковки, сборы и прочие расходы','fixed',1,null,'Уточнить сумму либо поставить 0, если расходов нет.','Прочее')],
      notes:'Себестоимость без наценки VOYZ. Расходы гидов входят в расходы тура и распределяются на гостей. Обеды и ужины гостей оплачиваются ими самостоятельно. Для коней используется правило: участники + 1 конь конюха по той же ставке. Жильё 5 000 с человека за ночь, с завтраком. Аренда пока на 8 суток; меняется отдельно для каждой машины. Пробег и расход задаются на одну машину.'};
  }
  function validate(raw){
    const b=structuredClone(raw);if(!b||b.version!==1||typeof b.title!=='string'||b.title.length>300||!/^[0-9a-f-]{36}$/i.test(b.id))throw Error('Неверный файл сметы.');
    b.projectId=b.projectId||'unassigned';if(typeof b.projectId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(b.projectId))throw Error('Неверная поездка.');const s=b.settings;if(!s||!Number.isInteger(s.guests)||s.guests<1||s.guests>1000||!Number.isInteger(s.guides)||s.guides<0||s.guides>100||!Number.isInteger(s.days)||s.days<1||s.days>365)throw Error('Проверьте число гостей, гидов и дней.');
    s.currency=s.currency||'KGS';s.rates=s.rates||{USD:s.fx??null};s.nights=s.nights??6;s.stage=s.stage||'planning';s.autoCars=s.autoCars??true;
    if(!/^[A-Z]{3}$/.test(s.currency)||!Number.isInteger(s.nights)||s.nights<0||s.nights>365||!['planning','active','completed','archived'].includes(s.stage)||typeof s.autoCars!=='boolean'||!s.rates||typeof s.rates!=='object'||Array.isArray(s.rates)||Object.keys(s.rates).length>30)throw Error('Проверьте валюту, ночи и статус.');
    for(const [k,v] of Object.entries(s.rates))if(!/^[A-Z]{3}$/.test(k)||!valid(v)||v===0)throw Error('Проверьте курсы валют.');
    for(const k of ['salePrice','received'])if(!valid(s[k]))throw Error('Проверьте цену и оплаты.');
    if(!Array.isArray(b.lines)||b.lines.length>500||!Array.isArray(b.vehicles)||b.vehicles.length>50)throw Error('Слишком много строк.');
    if(b.deletedAt&&(typeof b.deletedAt!=='string'||!Number.isFinite(Date.parse(b.deletedAt))))throw Error('Неверная дата удаления.');
    const ids=new Set();for(const r of [...b.lines,...b.vehicles]){r.inactive=r.inactive??false;if(typeof r.inactive!=='boolean')throw Error('Неверный статус строки.');if(typeof r.id!=='string'||!/^[0-9a-f-]{36}$/i.test(r.id)||ids.has(r.id)||typeof r.name!=='string'||r.name.length>500)throw Error('Неверная строка сметы.');ids.add(r.id);if(!/^[A-Z]{3}$/.test(r.currency))throw Error('Неверная валюта.');}
    for(const r of b.lines){r.extra=r.extra??0;r.unitsMode=r.unitsMode||'fixed';r.closed=r.closed??false;if(typeof r.closed!=='boolean')throw Error('Неверный статус статьи.');if(!['fixed','guests','guides','all'].includes(r.basis)||!['fixed','days','nights'].includes(r.unitsMode)||!valid(r.extra)||r.extra===null||typeof r.note!=='string'||r.note.length>5000||typeof r.category!=='string'||r.category.length>100)throw Error('Неверная статья.');for(const k of ['units','price','actual'])if(!valid(r[k]))throw Error('Цена и количество должны быть неотрицательными.');}
    for(const v of b.vehicles){v.rentClosed=v.rentClosed??false;v.fuelClosed=v.fuelClosed??false;if(typeof v.rentClosed!=='boolean'||typeof v.fuelClosed!=='boolean')throw Error('Неверный статус авто.');v.fuelCurrency=v.fuelCurrency||'KGS';if(!/^[A-Z]{3}$/.test(v.fuelCurrency))throw Error('Неверная валюта бензина.');for(const k of ['count','days','rent','km','consumption','fuelPrice','actualRent','actualFuel'])if(!valid(v[k]))throw Error('Проверьте параметры машины.');}
    if(typeof b.notes!=='string'||b.notes.length>20000)throw Error('Слишком длинные заметки.');if(b.groupingVersion!==2){b.lines.forEach(r=>r.category=legacyCategory(r));b.groupingVersion=2;}return b;
  }
  const people=(s,basis)=>basis==='guests'?s.guests:basis==='guides'?s.guides:basis==='all'?s.guests+s.guides:1;
  function product(...vs){if(vs.includes(0))return 0;return vs.some(v=>v===null)?null:vs.reduce((a,b)=>a*b,1);}
  function compute(b,income=null){
    const base=b.settings.currency||'KGS',rates=b.settings.rates||{USD:b.settings.fx??null};
    const kgs=(amount,currency)=>amount===0?0:amount===null?null:currency===base?round(amount):rates[currency]===null||rates[currency]===undefined?null:round(amount*rates[currency]);
    let rows=b.lines.map(r=>{const units=r.unitsMode==='days'?b.settings.days:r.unitsMode==='nights'?b.settings.nights:r.units,quantity=r.basis==='fixed'&&(!r.unitsMode||r.unitsMode==='fixed')?(units===null?null:units+(r.extra??0)):product(people(b.settings,r.basis)+(r.extra??0),units),native=product(quantity,r.price);return {id:r.id,name:r.name,category:r.category,quantity,native,currency:r.currency,plan:kgs(native,r.currency),actual:r.actual,closed:!!r.closed,inactive:!!r.inactive};});
    for(const v of b.vehicles){const qty=product(v.count,v.days),rent=product(qty,v.rent),litres=product(v.count,v.km,v.consumption,0.01),fc=v.fuelCurrency||'KGS';rows.push({id:v.id+'-rent',name:v.name+' · аренда',category:'Авто',quantity:qty,native:rent,currency:v.currency,plan:kgs(rent,v.currency),actual:v.actualRent,closed:!!v.rentClosed},{id:v.id+'-fuel',name:v.name+' · бензин',category:'Авто',quantity:litres,native:product(litres,v.fuelPrice),currency:fc,plan:kgs(product(litres,v.fuelPrice),fc),actual:v.actualFuel,closed:!!v.fuelClosed});}
    for(const v of b.vehicles)if(v.inactive)rows.filter(r=>r.id===v.id+'-rent'||r.id===v.id+'-fuel').forEach(r=>r.inactive=true);
    rows=rows.filter(r=>!r.inactive||r.actual!==null);rows.forEach(r=>{if(r.inactive){r.plan=0;r.native=0;r.quantity=0;r.closed=true;}r.forecast=r.closed?r.actual:r.plan===null?null:Math.max(r.plan,r.actual??0);r.delta=r.actual===null||r.plan===null?null:round(r.actual-r.plan);});
    const sum=k=>round(rows.reduce((s,r)=>s+(r[k]??0),0)),unknown=rows.filter(r=>r.plan===null).length,forecastUnknown=rows.filter(r=>r.forecast===null).length;
    const plan=sum('plan'),actual=sum('actual'),forecast=sum('forecast'),revenue=b.settings.incomeSource==='crm'?(income?.currency===base?income.revenue:null):product(b.settings.guests,b.settings.salePrice),received=b.settings.incomeSource==='crm'?(income?.currency===base?income.received:null):b.settings.received;
    return {rows,plan,actual,forecast,unknown,forecastUnknown,perGuest:round(plan/b.settings.guests),forecastPerGuest:round(forecast/b.settings.guests),remaining:round(rows.reduce((s,r)=>s+(r.forecast===null?0:Math.max(0,r.forecast-(r.actual??0))),0)),cash:received===null?null:round((received??0)-actual),received,revenue,profitPlan:unknown||revenue===null?null:round(revenue-plan),profitForecast:forecastUnknown||revenue===null?null:round(revenue-forecast),actualCount:rows.filter(r=>r.closed&&r.actual!==null).length};
  }
  function resize(b,kind,count){
    if(!['nights','cars'].includes(kind)||!Number.isInteger(count)||count<0||count>(kind==='nights'?365:50))throw Error('Введите целое неотрицательное количество.');
    const arr=kind==='nights'?b.lines.filter(r=>r.night):b.vehicles;
    const active=arr.filter(r=>!r.inactive),parked=arr.filter(r=>r.inactive);active.slice(count).forEach(r=>r.inactive=true);
    let needed=Math.max(0,count-active.length);for(const r of parked){if(!needed)break;r.inactive=false;needed--;}
    const base=kind==='nights'?(arr.filter(r=>!r.inactive).at(-1)||arr.at(-1)):(arr.find(r=>!r.inactive)||arr[0]);
    while(needed--){if(kind==='nights'){b.lines.push(base?{...structuredClone(base),id:uid(),name:'Ночь '+(b.lines.filter(r=>r.night).length+1),inactive:false,actual:null,closed:false,note:''}:{id:uid(),name:'Ночь '+(b.lines.filter(r=>r.night).length+1),night:true,category:'Жильё',basis:'all',units:1,unitsMode:'fixed',extra:0,price:null,currency:b.settings.currency,inactive:false,actual:null,closed:false,note:''});}
      else b.vehicles.push({...structuredClone(base||{days:b.settings.days,rent:null,currency:b.settings.currency,km:null,consumption:null,fuelPrice:null,fuelCurrency:b.settings.currency}),id:uid(),name:'Машина '+(b.vehicles.length+1),count:1,inactive:false,actualRent:null,actualFuel:null,rentClosed:false,fuelClosed:false});}
    if(kind==='nights')b.settings.nights=count;
  }
  function setCount(b,field,count){const limits={guests:[1,1000],guides:[0,100],days:[1,365],nights:[0,365]},limit=limits[field];if(!limit||!Number.isInteger(count)||count<limit[0]||count>limit[1])throw Error('Введите целое число от '+(limit?.[0]??0)+' до '+(limit?.[1]??365)+'.');if(field==='nights')resize(b,'nights',count);if(field==='guides'&&b.settings.autoCars)resize(b,'cars',count);if(field==='days')b.vehicles.forEach(v=>{if(v.days===b.settings.days)v.days=count;});b.settings[field]=count;}
  function setInactive(b,kind,id,value){const r=b[kind].find(r=>r.id===id);if(!r)throw Error('Строка не найдена.');r.inactive=value;if(kind==='lines'&&r.night)b.settings.nights=b.lines.filter(r=>r.night&&!r.inactive).length;if(kind==='vehicles')b.settings.autoCars=false;}
  function blank(title='Новая смета',projectId='unassigned'){const b=seed();b.title=title;b.projectId=projectId;b.lines=[];b.vehicles=[];b.notes='';b.settings.nights=0;b.settings.autoCars=false;return validate(b);}
  function duplicate(source,title){const b=structuredClone(source);delete b.deletedAt;b.id=uid();b.title=title||source.title+' · копия';return validate(b);}
  function crmIncome(doc){const crm=doc?.crm;if(!crm)return null;const clients=crm.clients.filter(c=>c.status!=='cancelled');return {currency:crm.currency,guests:clients.length,revenue:round(clients.reduce((n,c)=>n+Number(c.price||0),0)),received:round(clients.reduce((n,c)=>n+Number(c.deposit||0)+Number(c.payment||0),0))};}
  function legacyCategory(r){if(r.night||/жиль|прожив/i.test(r.category))return 'Жильё';if(/кон[ьи]|лошад/i.test(r.name)||/кони/i.test(r.category))return 'Кони';if(/авто|транспорт|заброс|трансфер/i.test(r.category))return 'Транспорт';if(/сбор|пропуск|вход/i.test(r.category))return 'Входы и пропуска';if(/питан|команд/i.test(r.category))return 'Питание команды';if(/актив|развлеч/i.test(r.category))return 'Активности';return 'Другое';}
  function category(r){return ['Жильё','Транспорт','Кони','Активности','Входы и пропуска','Питание команды','Другое'].includes(r.category)?r.category:legacyCategory(r);}
  function portfolio(budgets,choices={},incomes={}){const result={};for(const b of budgets){if(b.deletedAt||b.settings.stage==='archived'||choices[b.projectId||'unassigned']!==b.id)continue;const currency=b.settings.currency||'KGS',c=compute(b,incomes[b.projectId]),p=result[currency]||(result[currency]={count:0,knownPlan:0,actual:0,received:0,revenue:0,forecast:0,forecastProfit:0,completedProfit:0,incomplete:0,completed:0});p.count++;p.knownPlan+=c.plan;p.actual+=c.actual;p.received+=c.received??0;p.revenue+=c.revenue??0;p.forecast+=c.forecast;if(c.profitForecast!==null)p.forecastProfit+=c.profitForecast;else p.incomplete++;if(b.settings.stage==='completed'&&c.rows.every(r=>r.closed&&r.actual!==null)&&c.revenue!==null){p.completed++;p.completedProfit+=c.revenue-c.actual;}}return result;}
  const api={seed,blank,duplicate,crmIncome,category,validate,compute,people,resize,setCount,setInactive,portfolio,uid,n,round};if(typeof module!=='undefined')module.exports=api;else root.VoyzBudget=Object.freeze(api);
})(typeof window==='undefined'?globalThis:window);

