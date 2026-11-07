const {verifySessionToken,getBearerToken}=require('./auth-utils');
const {assemble}=require('./lib/oil-current-mileage');
const {enrich}=require('./lib/oil-repair-history');
const M=require('../public/oil-tracking-model');
const json=(statusCode,value)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(value)});
function createHandler(repository,{verify=verifySessionToken,mode='local-read-only'}={}) {
  return async event=>{
    try {
      let actor;try{const token=getBearerToken(event);if(token.split('.').length!==2)throw new Error();actor=verify(token);}catch(_){return json(401,{success:false,message:'กรุณาเข้าสู่ระบบใหม่'});}
      if(!actor?.id||!['admin','manager','user'].includes(actor.role))return json(403,{success:false,message:'ไม่มีสิทธิ์ดูข้อมูลรถ'});
      if(event.httpMethod!=='GET')return json(405,{success:false,message:'อ่านข้อมูลได้เท่านั้น'});
      const {buses,hrVehicles,clearances,repairs=[]}=await repository.read();
      const asOf=M.today(),records=enrich(assemble(buses,hrVehicles,clearances,asOf),repairs,asOf);
      return json(200,{success:true,mode,persisted:false,asOf,fetchedAt:new Date().toISOString(),records,total:records.length});
    }catch(_){return json(503,{success:false,message:'อ่านข้อมูล Feet / HR-POS ไม่สำเร็จ กรุณาตรวจการตั้งค่า Server หรือการเชื่อมต่อ ไม่มีการใช้ข้อมูลจำลองแทน'});}
  };
}
async function allRows(client,table,columns,order) {
  const rows=[];
  for(let start=0;;start+=500){
    const {data,error}=await client.from(table).select(columns).order(order).range(start,start+499);
    if(error||!Array.isArray(data))throw new Error('Read failed');rows.push(...data);
    if(data.length<500)return rows;
    if(rows.length>=100000)throw new Error('Read limit exceeded');
  }
}
function createLocalHandler(rootDir, options) {
  // Read each project's local config independently; never export credentials.
  const fs=require('fs'),path=require('path'),dotenv=require('dotenv');
  function config(dir){const env={};for(const name of ['.env','.env.local']){const file=path.join(dir,name);if(fs.existsSync(file))Object.assign(env,dotenv.parse(fs.readFileSync(file)));}return env;}
  const feet=config(rootDir),hr=config(process.env.HRPOS_PROJECT_DIR||path.join(path.dirname(rootDir),'HR-POS FOR SUPPABASE'));
  return createConfiguredHandler(feet,hr,options);
}
function createConfiguredHandler(feet,hr,options={},createClient=require('@supabase/supabase-js').createClient) {
  if(!feet.SUPABASE_URL||!hr.SUPABASE_URL||feet.SUPABASE_URL.replace(/\/$/,'')===hr.SUPABASE_URL.replace(/\/$/,''))throw new Error('Separate project configurations required');
  const readFetch=(url,options={})=>{
    if(String(options.method||'GET').toUpperCase()!=='GET')throw new Error('Read-only transport');
    return fetch(url,{...options,signal:AbortSignal.timeout(12000)});
  };
  function client(env){const key=env.SUPABASE_KEY||env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_ANON_KEY;if(!key)throw new Error('Missing configuration');return createClient(env.SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:readFetch}});}
  const feetDb=client(feet),hrDb=client(hr);
  return createHandler({async read(){
    // Allowlisted tables/columns only; no financial, staff, or attachment data.
    const buses=await allRows(feetDb,'buses','plate','plate');
    const hrVehicles=await allRows(hrDb,'vehicles','plate_no,vehicle_type','row_id');
    const clearances=await allRows(hrDb,'clearance','row_id,clearance_code,job_no,vehicle_plate,return_date,odom_before,odom_after','row_id');
    const repairs=await allRows(feetDb,'repairs','repair_no,date,plate,mileage,oil_program,repair_list,repair_summary,status','repair_no');
    return {buses,hrVehicles,clearances,repairs};
  }},options);
}
exports.createHandler=createHandler;
exports.createLocalHandler=createLocalHandler;
exports.createConfiguredHandler=createConfiguredHandler;
exports.handler=async event=>{
  try {
    const hr={SUPABASE_URL:process.env.HRPOS_SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.HRPOS_SUPABASE_SERVICE_ROLE_KEY};
    return await createConfiguredHandler(process.env,hr,{mode:'read-only'})(event);
  }catch(_){return json(503,{success:false,message:'ยังอ่านข้อมูล Feet / HR-POS ไม่ได้ กรุณาตรวจการตั้งค่า Server ไม่มีการใช้ข้อมูลจำลองแทน'});}
};
