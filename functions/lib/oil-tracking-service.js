const crypto = require('crypto');
const M = require('../../public/oil-tracking-model');

class OilError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new OilError(status, message); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'รูปแบบข้อมูลไม่ถูกต้อง');
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'พบข้อมูลที่ไม่อนุญาตให้แก้ไข');
}
function text(value, limit, required = false) {
  if (value !== undefined && typeof value !== 'string') fail(400, 'ข้อมูลข้อความไม่ถูกต้อง');
  const result = (value || '').trim();
  if (result.length > limit || (required && !result)) fail(400, 'กรุณาระบุข้อความให้ครบและไม่เกินความยาวที่กำหนด');
  return result;
}
function numeric(value) {
  if (!['number','string'].includes(typeof value) || (typeof value==='string' && !/^\d+$/.test(value.trim()))) fail(400,'ข้อมูลตัวเลขไม่ถูกต้อง');
  return M.mileage(value);
}
function policy(input) {
  fields(input,['groups','warnKm','warnDays','staleDays']);
  fields(input.groups,Object.keys(M.groups));
  for (const key of Object.keys(M.groups)) {
    fields(input.groups[key],['name','km','months']);
    numeric(input.groups[key].km); numeric(input.groups[key].months);
  }
  for (const key of ['warnKm','warnDays','staleDays']) numeric(input[key]);
  return M.settings(input);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = (action, input) => crypto.createHash('sha256').update(JSON.stringify(canonical({action,input}))).digest('hex');
function validateSnapshot(state) {
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !['vehicles','services','readings','audit'].every(key => Array.isArray(state[key]))) fail(503, 'โครงสร้างข้อมูลติดตามยังไม่พร้อมใช้งาน');
  try { M.settings(state.settings); } catch (_) { fail(503, 'ข้อมูลเกณฑ์บำรุงรักษาไม่ครบ ห้ามใช้ค่าแทนโดยอัตโนมัติ'); }
  return state;
}
function actorSnapshot(actor) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || actor.id.length > 100 || !['admin','manager','user'].includes(actor.role)) fail(403, 'ไม่มีสิทธิ์ใช้งานเมนูนี้');
  return { id:actor.id, name:String(actor.name || '').slice(0,150), username:String(actor.username || '').slice(0,100), role:actor.role };
}
function prepare(state, actor, action, input, {now = new Date().toISOString(), id = crypto.randomUUID} = {}) {
  validateSnapshot(state); actor = actorSnapshot(actor);
  if (actor.role !== 'admin') fail(403, 'เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
  const asOf = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  let mutation, before = null, after, entityId, auditAction;
  const findVehicle = vehicleId => {
    if (!uuid(vehicleId)) fail(400, 'รหัสรถไม่ถูกต้อง');
    const v = state.vehicles.find(v => v.id === vehicleId);
    if (!v) fail(404, 'ไม่พบรถที่ลงทะเบียนติดตาม');
    return v;
  };
  if (action === 'registerVehicle') {
    fields(input,['plate','type','reason']);
    const plate = text(input.plate,100,true), type = text(input.type,20), reason = text(input.reason,1000,true);
    if (!['','bus','minibus','van'].includes(type)) fail(400, 'ประเภทรถไม่ถูกต้อง');
    if (state.vehicles.some(v => v.plate === plate)) fail(409, 'ทะเบียนนี้มีในระบบติดตามแล้ว');
    after = {id:id(),plate,type}; entityId = after.id;
    mutation = {kind:'vehicle.create',value:after}; auditAction='vehicle.register';
    after = {...after,reason};
  } else if (action === 'classify') {
    fields(input,['vehicleId','type','reason']);
    before = findVehicle(input.vehicleId);
    const type = text(input.type,20), reason = text(input.reason,1000,true);
    if (!['','bus','minibus','van'].includes(type)) fail(400, 'ประเภทรถไม่ถูกต้อง');
    after = {...before,type,reason};entityId=before.id;
    mutation={kind:'vehicle.classify',value:{...before,type}};auditAction='vehicle.classify';
  } else if (action === 'configure') {
    fields(input,['settings','reason']);
    const reason=text(input.reason,1000,true);
    before=M.clone(state.settings);
    after={settings:policy(input.settings),reason};entityId='oil-tracking';
    mutation={kind:'settings.create',id:id(),value:after.settings};auditAction='settings.update';
  } else if (action === 'service' || action === 'reading') {
    fields(input,['vehicleId','date','odometer','note','supersedes','reason',...(action==='service'?['program','repairRef']:[])]);
    findVehicle(input.vehicleId);
    const kind=action==='service'?'services':'readings';
    if (input.supersedes) {
      if (!uuid(input.supersedes)) fail(400, 'รหัสประวัติไม่ถูกต้อง');
      before=M.effective(state[kind]).find(e => e.id===input.supersedes&&e.vehicleId===input.vehicleId);
      if (!before) fail(409, 'ฉบับเดิมถูกแก้ไขแล้ว หรือไม่ใช่ประวัติของรถคันนี้');
    }
    after={id:id(),vehicleId:input.vehicleId,date:input.date,odometer:numeric(input.odometer),note:text(input.note,1000),
      supersedes:before?.id||null,reason:text(input.reason,1000,!!before),sequence:state.revision+1,actor,recordedAt:now};
    if (action==='service') {
      if (!['S','M','S2','L'].includes(input.program)) fail(400, 'กรุณาเลือกโปรแกรม S/M/S2/L');
      after.program=input.program;after.repairRef=text(input.repairRef,100);
    } else after.source='manual';
    const oils=M.effective(kind==='services'?[...state.services,after]:state.services).filter(e=>e.vehicleId===input.vehicleId);
    const reads=M.effective(kind==='readings'?[...state.readings,after]:state.readings).filter(e=>e.vehicleId===input.vehicleId);
    M.validateTimeline(oils,reads,asOf);
    if (!before) {
      const last=M.latest(M.effective(state[kind]).filter(e=>e.vehicleId===input.vehicleId));
      if (last && last.date===after.date && last.odometer>after.odometer) fail(400,'เลขไมล์ลดลงจากประวัติล่าสุดในวันเดียวกัน');
    }
    entityId=after.vehicleId;mutation={kind:'event.create',collection:kind,value:after};auditAction=kind+(before?'.correct':'.create');
  } else fail(400, 'คำสั่งไม่ถูกต้อง');
  const audit={id:id(),action:auditAction,entityId,before,after,actor,timestamp:now};
  return {mutation,audit,result:{entityId,value:after,revision:state.revision+1}};
}
function apply(state, command) {
  const next=M.clone(state), m=command.mutation;
  if (m.kind==='vehicle.create') next.vehicles.push(m.value);
  else if (m.kind==='vehicle.classify') next.vehicles=next.vehicles.map(v=>v.id===m.value.id?m.value:v);
  else if (m.kind==='settings.create') next.settings=m.value;
  else if (m.kind==='event.create') next[m.collection].push(m.value);
  else fail(400,'คำสั่งธุรกรรมไม่ถูกต้อง');
  next.audit.push(command.audit);next.revision++;
  return next;
}
module.exports={OilError,fail,uuid,fields,fingerprint,validateSnapshot,actorSnapshot,prepare,apply};
