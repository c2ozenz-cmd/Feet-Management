// Deliberately does not load dotenv, Supabase, or any application function.
const http = require('http');
const fs = require('fs');
const path = require('path');
const files = new Set(['oil-tracking-demo.html','oil-tracking.css','oil-tracking-model.js','oil-tracking-demo-store.js','oil-tracking.js']);
const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8' };
let port = Number(process.env.OIL_DEMO_PORT || 5190);
const server = http.createServer((req,res)=>{
  const name = new URL(req.url,'http://localhost').pathname.slice(1) || 'oil-tracking-demo.html';
  if(req.method !== 'GET' || !files.has(name)) {res.writeHead(404);res.end('Local demo only: no API routes');return;}
  res.writeHead(200,{'Content-Type':types[path.extname(name)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(path.join(__dirname,'public',name)).pipe(res);
});
server.on('error',error=>{if(error.code==='EADDRINUSE'&&port<5210)server.listen(++port,'127.0.0.1');else{console.error(error.message);process.exitCode=1;}});
server.on('listening',()=>console.log(`Oil tracking LOCAL DEMO: http://localhost:${port}/oil-tracking-demo.html (no database/API)`));
server.listen(port,'127.0.0.1');
