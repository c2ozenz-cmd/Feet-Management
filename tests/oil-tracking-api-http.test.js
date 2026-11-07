const assert=require('node:assert/strict');
const crypto=require('crypto');
const http=require('http');
const {createDemoServer}=require('../run-oil-api-demo');
(async()=>{
  const server=createDemoServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  try {
    const info=await(await fetch(base)).json();assert.equal(info.persisted,false);
    assert.equal((await fetch(base+'/.netlify/functions/oil-tracking')).status,401);
    const admin=await(await post('/demo/session',{role:'admin'})).json();
    const headers={Authorization:'Bearer '+admin.token};
    const list=await(await fetch(base+'/.netlify/functions/oil-tracking',{headers})).json();assert.equal(list.total,12);assert.equal(list.mode,'local-api-mock');
    const vehicleId=list.records.find(r=>r.vehicle.plate==='30-1002 สข').vehicle.id;
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const body={action:'reading',input:{vehicleId,date,odometer:1000},expectedRevision:0,requestId:crypto.randomUUID()};
    const a=await(await post('/.netlify/functions/oil-tracking',body,headers)).json();assert.equal(a.success,true);assert.equal(a.persisted,false);
    const b=await(await post('/.netlify/functions/oil-tracking',body,headers)).json();assert.equal(b.replayed,true);assert.equal(b.value.id,a.value.id);
    const user=await(await post('/demo/session',{role:'user'})).json();
    assert.equal((await post('/.netlify/functions/oil-tracking',{...body,expectedRevision:1,requestId:crypto.randomUUID()},{Authorization:'Bearer '+user.token})).status,403);
    assert.equal((await post('/demo/session',{role:'admin'},{Origin:'https://untrusted.invalid'})).status,403);
    const badHost=await new Promise((resolve,reject)=>{http.get(base,{headers:{Host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
    assert.equal(badHost,403);
    assert.equal((await fetch(base+'/.env')).status,404);
    assert.equal((await post('/.netlify/functions/line-send-po',{})).status,404);
    console.log('PASS: loopback HTTP API, signed demo sessions, authenticated read/write, replay, read-only role, Origin/Host checks, no real routes');
  }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
