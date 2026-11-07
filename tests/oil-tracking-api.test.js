const assert=require('node:assert/strict');
const crypto=require('crypto');
const {createHandler,handler:disabled}=require('../functions/oil-tracking');
const {createMemoryRepository}=require('../functions/lib/oil-tracking-memory');
const {createRpcRepository}=require('../functions/lib/oil-tracking-rpc-repository');
const {createSessionToken}=require('../functions/auth-utils');
const {fixture}=require('./helpers/oil-tracking-fixture');
const M=require('../public/oil-tracking-model');
process.env.APP_SESSION_SECRET=crypto.randomBytes(32).toString('hex');
const now='2026-11-06T05:00:00Z';
const admin={id:'test-admin',name:'Server Admin',username:'admin-test',role:'admin'};
const token=createSessionToken(admin);
const parse=response=>({status:response.statusCode,...JSON.parse(response.body)});
function setup(options={}) {
  const {state,ids}=fixture(),repo=createMemoryRepository(state,options),api=createHandler(repo,{clock:()=>now});
  const call=async(method,body={},query={},auth=token)=>parse(await api({httpMethod:method,headers:{authorization:'Bearer '+auth},body:JSON.stringify(body),queryStringParameters:query}));
  const write=(action,input,expectedRevision=0,requestId=crypto.randomUUID(),auth=token)=>call('POST',{action,input,expectedRevision,requestId},{},auth);
  return {repo,api,ids,call,write};
}
let tests=0;
async function test(name,run){await run();tests++;console.log('PASS:',name);}
(async()=>{
  await test('normal endpoint fails closed, even with credentials/configured environment',async()=>{
    const result=parse(disabled({httpMethod:'POST'}));assert.equal(result.status,503);assert.equal(result.code,'OIL_TRACKING_NOT_CONNECTED');
  });
  await test('signed session required; forged/expired token and extra segments rejected',async()=>{
    const {call}=setup();
    assert.equal((await call('GET',{}, {},'bad')).status,401);
    assert.equal((await call('GET',{}, {},token+'.extra')).status,401);
    assert.equal((await call('GET',{}, {},token.slice(0,-6)+'xxxxxx')).status,401);
    const expiredPayload=Buffer.from(JSON.stringify({...admin,exp:Date.now()-1000})).toString('base64url');
    const expired=expiredPayload+'.'+crypto.createHmac('sha256',process.env.APP_SESSION_SECRET).update(expiredPayload).digest('base64url');
    assert.equal((await call('GET',{}, {},expired)).status,401);
    const api=createHandler({read:()=>{throw new Error('must not read');}},{verify:()=>{throw new Error('expired');}});
    assert.equal((await api({httpMethod:'GET',headers:{authorization:'Bearer a.b'}})).statusCode,401);
    assert.equal((await call('GET',{}, {},createSessionToken({id:'guest',role:'guest'}))).status,403);
  });
  await test('User/Manager may read but cannot perform any mutation',async()=>{
    const {repo,call,write}=setup(),before=await repo.read();
    for(const role of ['user','manager']) {
      const auth=createSessionToken({id:role,name:role,role});
      assert.equal((await call('GET',{}, {},auth)).status,200);
      for(const action of ['service','reading','classify','configure','registerVehicle'])assert.equal((await write(action,{},0,crypto.randomUUID(),auth)).status,403);
    }
    assert.deepEqual(await repo.read(),before);
  });
  await test('server-side list/search/status/page/size and full history pagination',async()=>{
    const {call,ids}=setup();
    const list=await call('GET',{}, {pageSize:'5',page:'2'});assert.equal(list.records.length,5);assert.equal(list.total,12);assert.equal(list.persisted,false);
    assert.equal((await call('GET',{}, {search:'30-5115'})).records[0].rule.km,20000);
    assert.equal((await call('GET',{}, {status:'due'})).records.length,1);
    assert.equal((await call('GET',{}, {status:'bad'})).status,400);
    assert.equal((await call('GET',{}, {page:'0'})).status,400);
    assert.equal((await call('GET',{}, {pageSize:'101'})).status,400);
    assert.equal((await call('GET',{}, {action:'history',vehicleId:ids.get('demo-bus'),kind:'services'})).total,1);
    assert.equal((await call('GET',{}, {action:'history',vehicleId:crypto.randomUUID(),kind:'services'})).status,404);
    assert.equal((await call('GET',{}, {action:'history',vehicleId:ids.get('demo-bus'),kind:'unknown'})).status,400);
  });
  await test('valid service/reading/correction append without overwrite; actor/time cannot be forged',async()=>{
    const {repo,write,ids,call}=setup(),vehicleId=ids.get('demo-missing');
    const first=await write('service',{vehicleId,date:'2026-10-01',odometer:1000,program:'S2',note:'actual'});assert.equal(first.status,200);assert.equal(first.revision,1);
    assert.equal((await write('reading',{vehicleId,date:'2026-11-06',odometer:2000},1)).status,200);
    const edit=await write('service',{vehicleId,date:'2026-10-01',odometer:1100,program:'L',supersedes:first.value.id,reason:'แก้ตัวเลข'},2);
    assert.equal(edit.status,200);
    const state=await repo.read(),events=state.services.filter(e=>e.vehicleId===vehicleId);
    assert.equal(events.length,2);assert.equal(events[0].odometer,1000);assert.equal(events[1].actor.id,admin.id);assert.equal(events[1].recordedAt,now);
    assert.equal(state.audit.length,3);assert.equal(state.audit[2].before.odometer,1000);assert.equal(state.audit[2].after.odometer,1100);
    const history=await call('GET',{}, {action:'history',vehicleId,kind:'services'});assert.equal(history.records.filter(e=>e.active).length,1);
    assert.equal((await call('GET',{}, {search:'30-1002'})).records[0].status,'normal');
    assert.equal((await write('reading',{vehicleId,date:'2026-11-06',odometer:3000,actor:{id:'forged'},source:'hr-pos'},3)).status,400);
  });
  await test('mileage/date/program/reason validation occurs on server and leaves no partial record',async()=>{
    const {repo,write,ids}=setup(),vehicleId=ids.get('demo-bus'),before=await repo.read();
    const invalid=[
      ['reading',{date:'2026-11-07',odometer:200000}],['reading',{date:'2026-02-30',odometer:200000}],
      ['reading',{date:'2026-11-06',odometer:1}],['reading',{date:'2026-11-06',odometer:''}],
      ['reading',{date:'2026-11-06',odometer:[]}],['reading',{date:'2026-11-06',odometer:true}],
      ['service',{date:'2026-11-06',odometer:200000,program:'X'}],
      ['service',{date:'2026-11-06',odometer:200000,program:'S',supersedes:before.services[0].id}],
      ['service',{date:'2026-11-06',odometer:200000,program:'S',supersedes:before.services[1].id,reason:'wrong vehicle'}]
    ];
    for(const [action,input]of invalid)assert.ok([400,409].includes((await write(action,{vehicleId,...input})).status));
    assert.deepEqual(await repo.read(),before);
  });
  await test('idempotent retry succeeds with original result despite stale revision; changed payload conflicts',async()=>{
    const {repo,write,ids}=setup(),requestId=crypto.randomUUID(),input={vehicleId:ids.get('demo-missing'),date:'2026-11-01',odometer:1000};
    const first=await write('reading',input,0,requestId),second=await write('reading',input,0,requestId);
    assert.equal(second.status,200);assert.equal(second.replayed,true);assert.deepEqual(second.value,first.value);
    assert.equal((await write('reading',{...input,odometer:2000},0,requestId)).status,409);
    assert.equal((await write('reading',input,0,requestId.toUpperCase())).replayed,true);
    const state=await repo.read();assert.equal(state.revision,1);assert.equal(state.audit.length,1);
  });
  await test('concurrent different requests serialize: only one event/audit/revision commits',async()=>{
    const {repo,write,ids}=setup(),vehicleId=ids.get('demo-missing');
    const results=await Promise.all([write('reading',{vehicleId,date:'2026-11-06',odometer:1000}),write('reading',{vehicleId,date:'2026-11-06',odometer:2000})]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    const state=await repo.read();assert.equal(state.revision,1);assert.equal(state.audit.length,1);assert.equal(state.readings.filter(e=>e.vehicleId===vehicleId).length,1);
  });
  await test('concurrent identical request ID returns exactly one original event',async()=>{
    const {repo,write,ids}=setup(),id=crypto.randomUUID(),input={vehicleId:ids.get('demo-missing'),date:'2026-11-06',odometer:1000};
    const [a,b]=await Promise.all([write('reading',input,0,id),write('reading',input,0,id)]);
    assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.value.id,b.value.id);
    assert.equal((await repo.read()).audit.length,1);
  });
  await test('concurrent ID collision with different payload is rejected atomically',async()=>{
    const {repo,write,ids}=setup(),id=crypto.randomUUID(),input={vehicleId:ids.get('demo-missing'),date:'2026-11-06',odometer:1000};
    const results=await Promise.all([write('reading',input,0,id),write('reading',{...input,odometer:2000},0,id)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await repo.read()).audit.length,1);
  });
  await test('idempotency receipts are scoped to actor, not shared across users',async()=>{
    const {repo,write,ids}=setup(),requestId=crypto.randomUUID(),input={vehicleId:ids.get('demo-missing'),date:'2026-11-06',odometer:1000};
    const first=await write('reading',input,0,requestId);
    const auth=createSessionToken({id:'second-admin',name:'Second',role:'admin'});
    const second=await write('reading',input,1,requestId,auth);
    assert.equal(second.status,200);assert.notEqual(first.value.id,second.value.id);assert.equal((await repo.read()).audit.length,2);
  });
  await test('audit failure rolls back event + revision + receipt; same request may retry safely',async()=>{
    let fail=true;const {repo,write,ids}=setup({failAudit:()=>fail}),before=await repo.read(),requestId=crypto.randomUUID();
    const input={vehicleId:ids.get('demo-missing'),date:'2026-11-06',odometer:1000};
    assert.equal((await write('reading',input,0,requestId)).status,503);assert.deepEqual(await repo.read(),before);
    assert.equal(await repo.lookupRequest(admin.id,requestId),null);
    fail=false;assert.equal((await write('reading',input,0,requestId)).status,200);
  });
  await test('classification and policy audit preserve before/after; new unknown vehicle stays pending',async()=>{
    const {repo,write,ids,call}=setup();
    const register=await write('registerVehicle',{plate:'ทดสอบ-9000',type:'',reason:'manual test only'});assert.equal(register.status,200);
    assert.equal((await call('GET',{}, {search:'ทดสอบ-9000'})).records[0].status,'pending');
    assert.equal((await write('classify',{vehicleId:ids.get('demo-unknown'),type:'van',reason:'verified type'},1)).status,200);
    const settings=M.clone(M.defaults);settings.groups.special.km=18000;
    assert.equal((await write('configure',{settings:{...settings,warnDays:[]},reason:'bad schema'},2)).status,400);
    assert.equal((await write('configure',{settings,reason:'test policy'},2)).status,200);
    assert.equal((await call('GET',{}, {search:'30-5115'})).records[0].rule.km,18000);
    const state=await repo.read();assert.equal(state.audit[1].before.type,'');assert.equal(state.audit[2].before.groups.special.km,20000);
    assert.equal((await write('registerVehicle',{plate:'ทดสอบ-9000',type:'van',reason:'duplicate'},3)).status,409);
  });
  await test('bad JSON/body size/unknown fields/missing idempotency/method rejected',async()=>{
    const {api,call}=setup();
    const headers={authorization:'Bearer '+token};
    assert.equal((await api({httpMethod:'POST',headers,body:'{'})).statusCode,400);
    assert.equal((await api({httpMethod:'POST',headers,body:'x'.repeat(65537)})).statusCode,413);
    assert.equal((await call('DELETE')).status,405);
    assert.equal((await call('POST',{action:'reading',input:{}})).status,400);
    assert.equal((await call('POST',{action:'reading',requestId:crypto.randomUUID(),expectedRevision:0,input:{},actor:{role:'admin'}})).status,400);
  });
  await test('missing schema/storage errors do not create defaults or report success',async()=>{
    const api=createHandler({mode:'mock',read:async()=>({})});
    assert.equal((await api({httpMethod:'GET',headers:{authorization:'Bearer '+token}})).statusCode,503);
    const broken=createHandler({mode:'mock',read:async()=>{throw new Error('sensitive database secret');}});
    const response=await broken({httpMethod:'GET',headers:{authorization:'Bearer '+token}});assert.equal(response.statusCode,503);assert.ok(!response.body.includes('sensitive'));
  });
  await test('RPC adapter uses one commit call, explicit mode, maps conflicts, never constructs a real client',async()=>{
    assert.throws(()=>createRpcRepository({}),/mode/);
    const calls=[],client={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='fleet_oil_commit'?{result:{revision:1},replayed:false}:null,error:null};}};
    const repo=createRpcRepository(client,{mode:'mock-rpc'});await repo.read();await repo.lookupRequest('actor',crypto.randomUUID());
    await repo.commit({expectedRevision:0,actorId:'actor',requestId:crypto.randomUUID(),hash:'a'.repeat(64),command:{}});
    assert.deepEqual(calls.map(c=>c.name),['fleet_oil_snapshot','fleet_oil_request','fleet_oil_commit']);assert.equal(repo.persisted,false);
    for(const code of ['REVISION_CONFLICT','REQUEST_CONFLICT']) {
      const conflict=createRpcRepository({rpc:async()=>({data:{code},error:null})},{mode:'mock-rpc'});
      await assert.rejects(()=>conflict.read(),e=>e.status===409);
    }
  });
  console.log(`${tests} API test groups passed: signed mock sessions, in-memory transactions only; no SQL or external network.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
