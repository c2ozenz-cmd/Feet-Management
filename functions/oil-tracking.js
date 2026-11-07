const {verifySessionToken,getBearerToken} = require('./auth-utils');
const M = require('../public/oil-tracking-model');
const S = require('./lib/oil-tracking-service');
const response=(statusCode,value)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(value)});
const disabled=()=>response(503,{success:false,code:'OIL_TRACKING_NOT_CONNECTED',message:'API ติดตามยังไม่เปิดเชื่อมฐานข้อมูลจริง ใช้โหมดสาธิต Local เท่านั้น'});
function pageNumber(value, fallback, max=100000) {
  if (value===undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<1 || Number(value)>max) S.fail(400,'เลขหน้าหรือจำนวนต่อหน้าไม่ถูกต้อง');
  return Number(value);
}
function createHandler(repository, {verify=verifySessionToken, clock=()=>new Date().toISOString()}={}) {
  return async event=>{
    if (!repository) return disabled();
    try {
      const token=getBearerToken(event);
      let actor;
      try { if(token.split('.').length!==2)throw new Error();actor=S.actorSnapshot(verify(token)); }
      catch(error) { if(error.status===403)throw error;return response(401,{success:false,message:'กรุณาเข้าสู่ระบบใหม่'}); }
      const context={mode:repository.mode,persisted:repository.persisted===true};
      if (event.httpMethod==='GET') {
        const q=event.queryStringParameters||{},action=q.action||'list';
        if(!['list','history','audit','settings'].includes(action))S.fail(400,'คำสั่งไม่ถูกต้อง');
        const state=S.validateSnapshot(await repository.read());
        const common={success:true,...context,revision:state.revision};
        if(action==='settings')return response(200,{...common,settings:state.settings});
        const page=pageNumber(q.page,1),pageSize=pageNumber(q.pageSize,25,100);
        if(action==='list') {
          if(q.status&&!Object.hasOwn(M.statuses,q.status))S.fail(400,'สถานะไม่ถูกต้อง');
          const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(clock()));
          const all=state.vehicles.map(vehicle=>({vehicle,...M.evaluate(vehicle,state.services.filter(e=>e.vehicleId===vehicle.id),state.readings.filter(e=>e.vehicleId===vehicle.id),state.settings,asOf)}));
          const query=String(q.search||'').trim().toLowerCase();if(query.length>200)S.fail(400,'คำค้นยาวเกินไป');
          const rows=all.filter(r=>(!q.status||r.status===q.status)&&`${r.vehicle.plate} ${r.rule?.name||''}`.toLowerCase().includes(query)).sort((a,b)=>a.vehicle.plate.localeCompare(b.vehicle.plate,'th'));
          return response(200,{...common,asOf,records:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,counts:Object.fromEntries(Object.keys(M.statuses).map(key=>[key,all.filter(r=>r.status===key).length]))});
        }
        if(!S.uuid(q.vehicleId))S.fail(400,'รหัสรถไม่ถูกต้อง');
        if(!state.vehicles.some(v=>v.id===q.vehicleId))S.fail(404,'ไม่พบรถที่ลงทะเบียนติดตาม');
        let rows;
        if(action==='audit')rows=state.audit.filter(e=>e.entityId===q.vehicleId||e.entityId==='oil-tracking').sort((a,b)=>b.timestamp.localeCompare(a.timestamp));
        else {
          if(!['services','readings'].includes(q.kind))S.fail(400,'ประเภทประวัติไม่ถูกต้อง');
          const all=state[q.kind].filter(e=>e.vehicleId===q.vehicleId),active=new Set(M.effective(all).map(e=>e.id));
          rows=all.map(e=>({...e,active:active.has(e.id)})).sort((a,b)=>b.date.localeCompare(a.date)||b.sequence-a.sequence);
        }
        return response(200,{...common,records:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize});
      }
      if(event.httpMethod!=='POST')return response(405,{success:false,message:'รองรับ GET และ POST เท่านั้น'});
      if(actor.role!=='admin')S.fail(403,'เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
      if(event.isBase64Encoded||Buffer.byteLength(event.body||'','utf8')>65536)S.fail(413,'ข้อมูลคำขอมีขนาดใหญ่เกินไป');
      let body;try{body=JSON.parse(event.body||'{}');}catch(_){S.fail(400,'JSON ไม่ถูกต้อง');}
      S.fields(body,['action','requestId','expectedRevision','input']);
      if(!S.uuid(body.requestId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)S.fail(400,'ต้องระบุ requestId และ expectedRevision ที่ถูกต้อง');
      body.requestId=body.requestId.toLowerCase();
      const hash=S.fingerprint(body.action,body.input);
      const replay=await repository.lookupRequest(actor.id,body.requestId);
      if(replay) {
        if(replay.hash!==hash)S.fail(409,'requestId นี้ถูกใช้กับข้อมูลอื่นแล้ว');
        return response(200,{success:true,...context,...replay.result,replayed:true});
      }
      const state=S.validateSnapshot(await repository.read());
      if(body.expectedRevision!==state.revision)S.fail(409,'ข้อมูลถูกแก้ไขแล้ว กรุณารีเฟรชก่อนบันทึก');
      let command;
      try{command=S.prepare(state,actor,body.action,body.input,{now:clock()});}
      catch(error){if(error instanceof S.OilError)throw error;S.fail(400,error.message);}
      const committed=await repository.commit({expectedRevision:body.expectedRevision,requestId:body.requestId,actorId:actor.id,hash,command});
      return response(200,{success:true,...context,...committed.result,replayed:committed.replayed,message:context.persisted?'บันทึกแล้ว':'บันทึกในฐานข้อมูลจำลองเท่านั้น ไม่ได้บันทึกในระบบจริง'});
    }catch(error){
      return response(error instanceof S.OilError?error.status:503,{success:false,message:error instanceof S.OilError?error.message:'ระบบติดตามไม่พร้อมใช้งาน ยังไม่มีการยืนยันว่าบันทึกสำเร็จ'});
    }
  };
}
exports.createHandler=createHandler;
// Fail closed. No SDK import, client construction, environment switch or real connection.
exports.handler=disabled;
