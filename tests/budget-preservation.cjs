const assert=require('node:assert/strict'),M=require('../dist/budget-model'),Store=require('../dist/budget-store');
(async()=>{
 const b=M.validate(M.seed());b.lines[0].name='Каракол · гостевой дом';b.lines[0].price=3500;b.lines[0].note='Контакт хозяина';b.lines[5].name='Бишкек · отель';b.lines[5].price=4200;
 const before=structuredClone(b),nightSnapshot=b.lines.filter(r=>r.night).map(r=>structuredClone(r));
 for(const invalid of [null,undefined,'',-1,1.5,NaN]){assert.throws(()=>M.resize(b,'nights',invalid));assert.deepEqual(b,before);assert.throws(()=>M.setCount(b,'nights',invalid));assert.deepEqual(b,before);}
 M.setCount(b,'nights',1);assert.equal(b.lines.filter(r=>r.night).length,6);assert.equal(b.lines.filter(r=>r.night&&!r.inactive).length,1);
 M.setCount(b,'nights',0);M.setCount(b,'guests',8);M.setCount(b,'nights',6);
 assert.deepEqual(b.lines.filter(r=>r.night),nightSnapshot);assert.equal(b.settings.guests,8);
 M.setCount(b,'nights',16);M.setCount(b,'nights',7);assert.deepEqual(b.lines.filter(r=>r.night).slice(0,6),nightSnapshot);assert.equal(b.lines.filter(r=>r.night&&!r.inactive).length,7);
 M.setCount(b,'nights',6);b.lines[5].actual=1000;M.setCount(b,'nights',5);const inactiveRow=M.compute(b).rows.find(r=>r.id===b.lines[5].id);assert.equal(inactiveRow.plan,0);assert.equal(inactiveRow.actual,1000);assert.equal(inactiveRow.forecast,1000);
 M.setCount(b,'nights',6);assert.equal(b.lines[5].actual,1000);assert.equal(b.lines[5].name,'Бишкек · отель');
 M.setCount(b,'guides',3);b.vehicles[2].rent=72;b.vehicles[2].actualFuel=900;b.vehicles[2].name='Саня';const savedCar=structuredClone(b.vehicles[2]);
 M.setCount(b,'guides',1);assert.equal(b.vehicles.length,3);assert.equal(M.compute(b).rows.find(r=>r.id===savedCar.id+'-fuel').actual,900);M.setCount(b,'guides',3);assert.deepEqual(b.vehicles[2],savedCar);
 b.vehicles[1].days=4;M.setCount(b,'days',10);assert.equal(b.vehicles[0].days,10);assert.equal(b.vehicles[1].days,4);
 M.setInactive(b,'lines',b.lines[0].id,true);assert.equal(b.lines[0].price,3500);M.setInactive(b,'lines',b.lines[0].id,false);assert.equal(b.lines[0].note,'Контакт хозяина');
 b.projectId='trip';b.deletedAt=new Date().toISOString();assert.deepEqual(M.portfolio([b],{trip:b.id}),{});assert.equal(M.duplicate(b).deletedAt,undefined);
 const memory=new Map(),storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)},server={id:b.id,revision:1,document:b};
 const store=new Store({validate:M.validate,storage,write:async(id,revision,document)=>({revision:revision+1})});store.open('owner',[server]);assert.equal(store.activeId,null);store.select(b.id);store.edit(d=>delete d.deletedAt);await store.flush();assert.equal(store.active.document.lines[0].name,'Каракол · гостевой дом');assert.equal(store.active.document.lines[0].price,3500);
 for(const t of store.timers.values())clearTimeout(t);
 console.log('PASS: empty/invalid input is atomic; 6→1→0→6 and 6→16→7 preserve names, IDs, prices, notes; guests preserve lodging; guide counts preserve cars and facts; actual costs stay counted; deletion/restoration preserves the document and excludes it from totals');
})();
