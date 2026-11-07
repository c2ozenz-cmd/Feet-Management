const assert = require('node:assert/strict');
const M = require('../public/oil-tracking-model');
const Store = require('../public/oil-tracking-demo-store');
let tests = 0;
function test(name, run) { run(); tests++; console.log('PASS:', name); }
const now = '2026-11-06';
const oil = (overrides={}) => ({ id:'s1',date:'2026-08-01',odometer:100000,program:'S',sequence:1,...overrides });
const reading = (overrides={}) => ({ id:'r1',date:now,odometer:110000,sequence:2,...overrides });
const bus = {id:'bus',plate:'30-1111 สข',type:'bus'};
const evaluate = (v=bus, oils=[oil()], reads=[reading()], config=M.defaults, asOf=now) => M.evaluate(v,oils,reads,config,asOf);
test('all four maintenance groups and both exact plate exceptions, province suffix, precedence',()=>{
  assert.equal(M.rule(bus).km,35000);
  for(const plate of ['30-5115','30-5145 สข'])assert.equal(M.rule({plate,type:'van'}).km,20000);
  for(const plate of ['30-5456','30-5455 สข'])assert.equal(M.rule({plate,type:'bus'}).km,10000);
  assert.equal(M.rule({plate:'ฮท-1234',type:'van'}).km,10000);
  assert.equal(M.rule({plate:'30-1111',type:'minibus'}).km,10000);
  assert.equal(M.rule({plate:'30-51150',type:'bus'}).km,35000);
});
test('unknown type never falls back to general bus or guesses from model',()=>{
  assert.equal(M.rule({plate:'30-1999',model:'HINO BUS'}),null);
  assert.equal(evaluate({plate:'30-1999',model:'HINO BUS'}).status,'pending');
  assert.equal(M.rule({plate:'30-1999',type:'special'}),null);
});
test('six calendar months clamps month ends and leap years rather than adding 180 days',()=>{
  assert.equal(M.addMonths('2026-08-31',6),'2027-02-28');
  assert.equal(M.addMonths('2023-08-31',6),'2024-02-29');
  assert.equal(M.addMonths('2024-02-29',6),'2024-08-29');
  assert.equal(M.addMonths('2026-01-31',1),'2026-02-28');
  assert.equal(M.addMonths('2026-12-31',6),'2027-06-30');
  assert.throws(()=>M.date('2026-02-29'));
  assert.throws(()=>M.date('2026-04-31'));
  assert.throws(()=>M.addMonths('2026-01-01',0));
});
test('normal only with complete valid information',()=>{
  assert.equal(evaluate().status,'normal');
  assert.equal(evaluate().dueKm,135000);
  assert.equal(evaluate().dueDate,'2027-02-01');
  assert.equal(evaluate(bus,[]).status,'pending');
  assert.equal(evaluate(bus,[oil()],[]).status,'pending');
  assert.equal(evaluate(bus,[oil({odometer:null})]).status,'review');
  assert.equal(evaluate(bus,[oil({date:''})]).status,'review');
  assert.equal(evaluate(bus,[oil({id:'old'}),oil({date:null})]).status,'review');
  assert.equal(evaluate(bus,[oil({program:'X'})]).status,'review');
});
test('distance warning boundary inclusive at 2000 km, due inclusive at 0 km',()=>{
  assert.equal(evaluate(bus,[oil()],[reading({odometer:132999})]).status,'normal');
  assert.equal(evaluate(bus,[oil()],[reading({odometer:133000})]).status,'near');
  assert.equal(evaluate(bus,[oil()],[reading({odometer:135000})]).status,'due');
  assert.equal(evaluate(bus,[oil()],[reading({odometer:135001})]).remainingKm,-1);
});
test('date warning boundary inclusive at 30 days and due on due date, either condition first',()=>{
  const o=oil({date:'2026-01-31'}), end='2026-07-31';
  for(const [day,status] of [['2026-06-30','normal'],['2026-07-01','near'],[end,'due'],['2026-08-01','due']]) {
    assert.equal(evaluate(bus,[o],[reading({date:day,odometer:101000})],M.defaults,day).status,status);
  }
  assert.equal(evaluate({plate:'30-5455',type:''},[oil()],[reading()]).status,'due');
});
test('reject incomplete, decreasing, future, stale and invalid mileage/date values',()=>{
  for(const value of ['','  ',null,undefined,-1,NaN,Infinity,1.5,true])assert.throws(()=>M.mileage(value));
  assert.equal(M.mileage(0),0);
  assert.equal(evaluate(bus,[oil()],[reading({odometer:99999})]).status,'review');
  assert.equal(evaluate(bus,[oil()],[reading({date:'2026-12-01'})]).status,'review');
  assert.equal(evaluate(bus,[oil({date:'2026-12-01'})]).status,'review');
  assert.equal(evaluate(bus,[oil()],[reading({date:'2026-10-06'})]).status,'review');
  assert.notEqual(evaluate(bus,[oil()],[reading({date:'2026-10-07'})]).status,'review');
  assert.equal(evaluate(bus,[oil()],[reading({date:'2026-07-31'})]).status,'review');
  assert.equal(evaluate(bus,[oil()],[reading({date:'2026-02-30'})]).status,'review');
});
test('editable settings and plate priority survive custom group intervals',()=>{
  const config=M.clone(M.defaults);config.groups.special.km=18000;config.warnKm=500;
  assert.equal(M.rule({plate:'30-5115',type:'bus'},M.settings(config)).km,18000);
  assert.equal(evaluate({plate:'30-5115',type:'bus'},[oil()],[reading({odometer:117499})],config).status,'normal');
  assert.equal(evaluate({plate:'30-5115',type:'bus'},[oil()],[reading({odometer:117500})],config).status,'near');
  assert.throws(()=>M.settings({...config,warnDays:-1}));
  assert.equal(evaluate(bus,[oil()],[reading()],{}).status,'review');
});
test('each S/M/S2/L service restarts the cycle with its actual date and mileage',()=>{
  for(const program of ['S','M','S2','L']) {
    const r=evaluate(bus,[oil({id:'prior',date:'2026-02-01',odometer:80000}),oil({id:'actual',date:'2026-11-01',odometer:110000,program})],[reading({odometer:111000})]);
    assert.equal(r.dueKm,145000);assert.equal(r.dueDate,'2027-05-01');assert.equal(r.status,'normal');
  }
});
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
const admin={id:'demo-admin',name:'Tester',role:'admin'};
test('seed covers all groups and all statuses without real source data',()=>{
  const s=Store.seed(now), statuses=new Set(s.vehicles.map(v=>M.evaluate(v,s.services.filter(e=>e.vehicleId===v.id),s.readings.filter(e=>e.vehicleId===v.id),s.settings,now).status));
  assert.deepEqual([...statuses].sort(),Object.keys(M.statuses).sort());
  assert.equal(s.mode,'local-demo');
});
test('append history, corrections, actors, revision checks, local persistence and audit before/after',()=>{
  const storage=memory(), store=Store.open(storage,admin,now);
  const first=store.service({vehicleId:'demo-missing',date:'2026-08-01',odometer:1000,program:'S2',note:'actual',repairRef:''});
  store.reading({vehicleId:'demo-missing',date:now,odometer:2000});
  const corrected=store.service({vehicleId:'demo-missing',supersedes:first.id,date:'2026-08-01',odometer:1100,program:'L',reason:'แก้ตัวเลข'});
  const data=store.snapshot();
  assert.equal(data.services.find(e=>e.id===first.id).odometer,1000);
  assert.equal(M.effective(data.services).find(e=>e.vehicleId==='demo-missing').id,corrected.id);
  assert.equal(data.audit.length,3);
  assert.equal(data.audit[2].before.odometer,1000);
  assert.equal(data.audit[2].after.odometer,1100);
  assert.equal(data.audit[2].actor.id,admin.id);
  assert.equal(Store.open(storage,admin,now).snapshot().revision,3);
  assert.throws(()=>store.service({vehicleId:'demo-missing',supersedes:corrected.id,date:'2026-08-01',odometer:1200,program:'M'}),/เหตุผล/);
  assert.throws(()=>store.reading({vehicleId:'demo-missing',date:now,odometer:500}),/ไมล์ลดลง/);
  assert.throws(()=>store.reading({vehicleId:'demo-missing',date:'2026-11-07',odometer:3000}),/อนาคต/);
  assert.throws(()=>store.service({vehicleId:'demo-missing',date:now,odometer:3000,program:'X'}),/โปรแกรม/);
  assert.throws(()=>store.service({vehicleId:'demo-missing',date:'2026-08-01',odometer:1000,program:'S'}),/ไมล์ลดลง/);
  const stale=Store.open(storage,admin,now);
  store.classify('demo-unknown','van','ตรวจสอบประเภทรถแล้ว');
  assert.throws(()=>stale.configure(M.defaults),/หน้าจออื่น/);
  assert.equal(store.snapshot().audit.at(-1).before.type,'');
});
test('read-only roles and unknown actors cannot mutate; unauthorized operations leave state intact',()=>{
  for(const role of ['user','manager']) {
    const storage=memory(), store=Store.open(storage,{id:role,role},now), before=storage.getItem(Store.KEY);
    assert.equal(store.canWrite,false);
    assert.throws(()=>store.configure(M.defaults),/Admin/);
    assert.throws(()=>store.classify('demo-unknown','bus','reason'),/Admin/);
    assert.throws(()=>store.reading({vehicleId:'demo-missing',date:now,odometer:1}),/Admin/);
    assert.throws(()=>store.service({vehicleId:'demo-missing',date:now,odometer:1,program:'S'}),/Admin/);
    assert.equal(storage.getItem(Store.KEY),before);
  }
  assert.throws(()=>Store.open(memory(),null,now),/สิทธิ์/);
  assert.throws(()=>Store.open(memory(),{id:'x',role:'guest'},now),/สิทธิ์/);
});
test('corrupt storage fails closed instead of overwriting history',()=>{
  const storage=memory();storage.setItem(Store.KEY,'{"schema":99}');
  assert.throws(()=>Store.open(storage,admin,now),/เสียหาย/);
  assert.equal(storage.getItem(Store.KEY),'{"schema":99}');
});
test('append-only correction chain keeps latest active event only',()=>{
  const events=[oil({id:'a'}),oil({id:'b',supersedes:'a'}),oil({id:'c',supersedes:'b'})];
  assert.deepEqual(M.effective(events).map(e=>e.id),['c']);
});
console.log(`${tests} oil tracking test groups passed (mock storage only; no database calls).`);
