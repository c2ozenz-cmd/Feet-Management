const M=require('../../public/oil-tracking-model');
const canonical=value=>String(value||'').normalize('NFKC').toUpperCase().replace(/[–—]/g,'-').replace(/\s+/g,'');
const types=new Map([
  ['รถบัสปรับอากาศ 2 ชั้น 46 ที่นั่ง','bus'],['รถบัสปรับอากาศ 1 ชั้น 32 ที่นั่ง','bus'],
  ['รถบัสปรับอากาศ 1 ชั้น 40 ที่นั่ง','bus'],['รถบัสปรับอากาศ 1 ชั้น 46 ที่นั่ง','bus'],
  ['รถมินิบัสปรับอากาศ 20 ที่นั่ง','minibus'],['รถตู้ปรับอากาศ 10 ที่นั่ง','van']
]);
function plate(value) {
  const full=canonical(value),match=full.match(/^(\d{2}-\d{4})(.*)$/)||full.match(/^([ก-ฮA-Z]{1,3}-?\d{1,4})(.*)$/);
  return {full,base:match?match[1]:full,province:match?match[2]:''};
}
function numeric(value) {
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const n=Number(value);return Number.isSafeInteger(n)&&n>=0&&n<=100000000?n:null;
}
function assemble(buses,hrVehicles,clearances,asOf=M.today()) {
  const feetBases=new Map(),hrBases=new Map();
  for(const v of buses){const p=plate(v.plate);feetBases.set(p.base,(feetBases.get(p.base)||0)+1);}
  for(const v of hrVehicles){const p=plate(v.plate_no);const list=hrBases.get(p.base)||[];list.push(v);hrBases.set(p.base,list);}
  return buses.map(bus=>{
    const fp=plate(bus.plate),exact=hrVehicles.filter(v=>plate(v.plate_no).full===fp.full);
    const candidates=exact.length?exact:(hrBases.get(fp.base)||[]).filter(v=>{const hp=plate(v.plate_no);return !fp.province||!hp.province||fp.province===hp.province;});
    const ambiguous=candidates.length>1||(!exact.length&&((feetBases.get(fp.base)||0)>1||(hrBases.get(fp.base)||[]).length>1));
    let matched=!ambiguous&&candidates.length===1?candidates[0]:null;
    if(!ambiguous&&!matched&&clearances.some(r=>plate(r.vehicle_plate).full===fp.full))matched={plate_no:bus.plate,vehicle_type:''};
    const hp=matched?plate(matched.plate_no):null;
    const rows=matched?clearances.filter(row=>{
      const rp=plate(row.vehicle_plate);
      if(rp.full===hp.full||rp.full===fp.full)return true;
      return rp.base===fp.base&&(feetBases.get(fp.base)===1)&&(hrBases.get(fp.base)||[]).length===1&&(!rp.province||!fp.province||rp.province===fp.province)&&(!rp.province||!hp.province||rp.province===hp.province);
    }):[];
    const invalidDate=rows.some(row=>{try{M.date(row.return_date);return false;}catch(_){return true;}});
    rows.sort((a,b)=>String(b.return_date||'').localeCompare(String(a.return_date||''))||Number(b.row_id||0)-Number(a.row_id||0));
    const last=rows[0],previous=rows[1],odometer=last?numeric(last.odom_after):null;
    const issues=[];
    if(ambiguous)issues.push('ทะเบียนจับคู่ได้หลายคัน ต้องตรวจสอบก่อน');
    if(invalidDate)issues.push('พบวันที่กลับจากงานไม่ครบหรือไม่ถูกต้องใน HR-POS');
    if(last?.return_date>asOf)issues.push('วันที่กลับจากงานล่าสุดอยู่ในอนาคต');
    if(last&&numeric(last.odom_before)!==null&&odometer!==null&&numeric(last.odom_before)>odometer)issues.push('ไมล์กลับน้อยกว่าไมล์ก่อนไป');
    if(last&&previous&&numeric(previous.odom_after)!==null&&odometer!==null&&odometer<numeric(previous.odom_after))issues.push('ไมล์ล่าสุดลดลงจากรายการก่อนหน้า');
    if(last&&odometer===null)issues.push('เลขไมล์กลับล่าสุดไม่ถูกต้อง');
    let age=null;try{if(last)age=M.days(asOf,last.return_date);}catch(_){}
    if(age>30)issues.push('ข้อมูลไมล์จาก HR-POS เก่ากว่า 30 วัน');
    // Exact known type labels only, not guesses from a model or plate range.
    const vehicle={id:bus.plate,plate:bus.plate,type:types.get(String(matched?.vehicle_type||'').trim())||''},rule=M.rule(vehicle);
    const reading=last&&odometer>0?{odometer,date:last.return_date,source:'hr-pos',clearanceCode:last.clearance_code||'',jobNo:last.job_no||''}:null;
    const status=issues.length?'review':'pending';
    const reason=issues.join(' • ')||(!matched?'ไม่พบทะเบียนตรงกันใน HR-POS':!reading?'ยังไม่มีไมล์กลับที่บันทึกครบใน HR-POS':'รอระบุวัน/ไมล์เปลี่ยนถ่ายจริง'+(!rule?' และกลุ่มรอบรถ':''));
    return {vehicle,rule,reading,status,reason,matchedPlate:matched?.plate_no||null,hrVehicleType:matched?.vehicle_type||null,
      oil:null,dueKm:null,dueDate:null,remainingKm:null,remainingDays:null,
      sourceHistory:rows.slice(0,5).map(r=>({date:r.return_date||null,odometer:numeric(r.odom_after),before:numeric(r.odom_before),clearanceCode:r.clearance_code||'',jobNo:r.job_no||''}))};
  });
}
module.exports={canonical,plate,assemble};
