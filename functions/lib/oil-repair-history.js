const M=require('../../public/oil-tracking-model');
const {canonical,plate}=require('./oil-current-mileage');
const cycle=['S','M','S2','L'];
const alias={S:'S',S1:'S',M:'M',PM:'M',S2:'S2',PS2:'S2',L:'L'};
const program=value=>alias[String(value||'').trim().toUpperCase()]||null;
function miles(value){const n=Number(value);return value!==null&&value!==''&&Number.isSafeInteger(n)&&n>0&&n<=100000000?n:null;}
function enrich(records,repairs,asOf=M.today()) {
  const bases=new Map();for(const r of records){const base=plate(r.vehicle.plate).base;bases.set(base,(bases.get(base)||0)+1);}
  return records.map(record=>{
    const fp=plate(record.vehicle.plate);
    const matching=repairs.filter(r=>{
      const rp=plate(r.plate);
      return canonical(r.plate)===fp.full||(rp.base===fp.base&&bases.get(fp.base)===1&&(!rp.province||!fp.province||rp.province===fp.province));
    });
    const oilRows=matching.filter(r=>program(r.oil_program)||/เปลี่ยน.{0,12}น้ำมันเครื่อง|ถ่าย.{0,8}น้ำมันเครื่อง/.test([r.repair_list,r.repair_summary].join(' ')));
    const completed=oilRows.filter(r=>r.status==='เสร็จแล้ว').sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.repair_no).localeCompare(String(a.repair_no)));
    const last=completed[0],issues=[];
    const repairHistory=completed.map(r=>({repairNo:r.repair_no,date:r.date,odometer:miles(r.mileage),program:program(r.oil_program),status:r.status}));
    const pendingOilRepairs=oilRows.filter(r=>r.status!=='เสร็จแล้ว').map(r=>({repairNo:r.repair_no,date:r.date,program:program(r.oil_program),status:r.status}));
    if(!last)return {...record,repairHistory,pendingOilRepairs,nextProgram:null};
    const oil={id:last.repair_no,repairNo:last.repair_no,date:last.date,odometer:miles(last.mileage),program:program(last.oil_program),source:'completed-repair',dateSource:'repair.date'};
    if(!oil.odometer)issues.push('ใบงานที่เสร็จแล้วล่าสุดไม่ได้ระบุเลขไมล์ (0/ว่าง)');
    if(!oil.program)issues.push('ใบงานที่เสร็จแล้วล่าสุดไม่ได้ระบุโปรแกรม');
    try{M.date(oil.date);if(oil.date>asOf)issues.push('วันที่ใบงานที่เสร็จแล้วอยู่ในอนาคต');}catch(_){issues.push('วันที่ใบงานล่าสุดไม่ถูกต้อง');}
    const text=[last.repair_list,last.repair_summary].join(' ').toUpperCase();
    const mentioned=[...text.matchAll(/โปรแกรม\s*(PS2|S2|S1|PM|S|M|L)(?![A-Z0-9])/g)].map(m=>program(m[1]));
    if(oil.program&&mentioned.some(p=>p!==oil.program))issues.push('โปรแกรมในช่องข้อมูลไม่ตรงกับรายละเอียดใบงาน ต้องยืนยันก่อน');
    const previous=repairHistory[1];if(previous?.odometer&&oil.odometer&&oil.odometer<previous.odometer)issues.push('ไมล์เปลี่ยนถ่ายล่าสุดลดลงจากใบงานก่อนหน้า');
    const base={...record,oil,repairHistory,pendingOilRepairs,nextProgram:oil.program&&!issues.length?cycle[(cycle.indexOf(oil.program)+1)%cycle.length]:null};
    if(issues.length)return {...base,status:'review',reason:[...new Set([...(record.status==='review'?[record.reason]:[]),...issues])].join(' • ')};
    let dueKm=null,dueDate=null,remainingKm=null,remainingDays=null;
    if(record.rule){dueKm=oil.odometer+record.rule.km;dueDate=M.addMonths(oil.date,record.rule.months);remainingDays=M.days(dueDate,asOf);if(record.reading)remainingKm=dueKm-record.reading.odometer;}
    const calculated=M.evaluate(record.vehicle,[oil],record.reading?[record.reading]:[],M.defaults,asOf);
    const status=record.status==='review'?'review':calculated.status;
    const reason=record.status==='review'?record.reason:calculated.reason;
    return {...base,dueKm,dueDate,remainingKm,remainingDays,status,reason};
  });
}
module.exports={cycle,program,enrich};
