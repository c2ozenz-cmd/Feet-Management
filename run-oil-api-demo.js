// Isolated loopback API sandbox. Never imports dotenv or a Supabase client.
const http=require('http');
const crypto=require('crypto');
const {createHandler}=require('./functions/oil-tracking');
const {createMemoryRepository}=require('./functions/lib/oil-tracking-memory');
const {createMockData}=require('./functions/lib/oil-tracking-mock-data');
const {OilError}=require('./functions/lib/oil-tracking-service');

function createDemoServer() {
  const secret=crypto.randomBytes(32),repository=createMemoryRepository(createMockData().state);
  const sign=payload=>crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  const verify=token=>{
    const [payload,signature]=token.split('.'),expected=sign(payload),a=Buffer.from(signature||''),b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('Invalid demo session');
    const actor=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!actor.exp||Date.now()>actor.exp)throw new Error('Expired demo session');
    return actor;
  };
  const api=createHandler(repository,{verify});
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    try {
      const host=new URL('http://'+req.headers.host);
      const port=String(server.address().port);
      if(!['localhost','127.0.0.1'].includes(host.hostname)||host.port!==port)throw new OilError(403,'Localhost API sandbox only');
      if(req.headers.origin) {
        let origin;try{origin=new URL(req.headers.origin);}catch(_){throw new OilError(403,'Origin not allowed');}
        if(origin.protocol!=='http:'||!['localhost','127.0.0.1'].includes(origin.hostname)||origin.port!==port)throw new OilError(403,'Origin not allowed');
      }
      const url=new URL(req.url,host);
      if(!['/','/demo/session','/.netlify/functions/oil-tracking'].includes(url.pathname)){send(res,404,{success:false,message:'API sandbox routes only'});return;}
      let body='';
      if(req.method==='POST') {
        if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new OilError(415,'Use application/json');
        body=await new Promise((resolve,reject)=>{
          let size=0,parts=[],tooLarge=false;
          req.on('data',chunk=>{size+=chunk.length;if(size>65536){tooLarge=true;parts=[];}else if(!tooLarge)parts.push(chunk);});
          req.on('end',()=>tooLarge?reject(new OilError(413,'Request too large')):resolve(Buffer.concat(parts).toString('utf8')));
          req.on('error',reject);
        });
      }
      if(url.pathname==='/demo/session') {
        if(req.method!=='POST')throw new OilError(405,'Use POST for demo session');
        let data;try{data=JSON.parse(body);}catch(_){throw new OilError(400,'Invalid JSON');}
        if(!['admin','manager','user'].includes(data.role))throw new OilError(400,'Choose a demo role');
        const actor={id:'demo-'+data.role,name:'Local demo '+data.role,role:data.role,exp:Date.now()+3600000};
        const payload=Buffer.from(JSON.stringify(actor)).toString('base64url');
        send(res,200,{mode:'local-api-mock',persisted:false,token:payload+'.'+sign(payload),message:'Local demo session only; never valid on the real app'});return;
      }
      if(url.pathname==='/') {send(res,200,{mode:'local-api-mock',persisted:false,message:'In-memory API only. Data disappears on restart. No Supabase, HR-POS or LINE.'});return;}
      const result=await api({httpMethod:req.method,headers:req.headers,body,queryStringParameters:Object.fromEntries(url.searchParams)});
      res.writeHead(result.statusCode,result.headers);res.end(result.body);
    }catch(error){send(res,error instanceof OilError?error.status:500,{success:false,message:error instanceof OilError?error.message:'API sandbox error'});}
  });
  return server;
}
if(require.main===module) {
  const server=createDemoServer();let port=Number(process.env.OIL_API_DEMO_PORT||5191);
  server.on('error',error=>{if(error.code==='EADDRINUSE'&&port<5210)server.listen(++port,'127.0.0.1');else{console.error(error.message);process.exitCode=1;}});
  server.on('listening',()=>console.log(`Oil API MOCK ONLY: http://localhost:${port} (in-memory; no database)`));
  server.listen(port,'127.0.0.1');
}
module.exports={createDemoServer};
