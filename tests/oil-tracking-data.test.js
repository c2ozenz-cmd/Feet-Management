const assert=require('node:assert/strict');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('public/oil-tracking-data.js','utf8');
(async()=>{
  let calls=0,now=0,day='2026-11-06',fail=false,mode='local-read-only';
  const window={appSessionToken:'session-a'};
  const context={window,location:{hostname:'localhost'},sessionStorage:{getItem:()=>null},OilTrackingModel:{today:()=>day},Date:{now:()=>now},fetch:async()=>{
    calls++;return{ok:!fail,json:async()=>fail?{success:false,message:'source failed'}:{success:true,mode,records:[],fetchedAt:'2026-11-06T00:00:00Z'}};
  }};
  vm.runInNewContext(source,context);const read=window.OilTrackingData.read;
  await Promise.all([read(),read()]);assert.equal(calls,1,'deduplicate in-flight reads');
  await read();assert.equal(calls,1,'cache same session');
  await read({force:true});assert.equal(calls,2,'manual refresh bypasses cache');
  now=60001;await read();assert.equal(calls,3,'cache expires');
  day='2026-11-07';await read();assert.equal(calls,4,'new Bangkok day invalidates cache');
  window.appSessionToken='session-b';await read();assert.equal(calls,5,'new session cannot reuse old session data');
  fail=true;await assert.rejects(()=>read({force:true}),/source failed/);assert.equal(calls,6);
  fail=false;await read();assert.equal(calls,7,'failed refresh clears cache instead of using stale data');
  context.location.hostname='production.invalid';mode='read-only';await read({force:true});assert.equal(calls,8);
  mode='demo';await assert.rejects(()=>read({force:true}),/อ่านข้อมูล/);assert.equal(calls,9);
  console.log('PASS: shared in-flight request, 60-second cache, explicit refresh, day/session isolation, failure invalidation, production read-only and rejected demo responses (no network)');
})().catch(error=>{console.error(error);process.exitCode=1;});
