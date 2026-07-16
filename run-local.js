const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config();

const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const preferredPort = Number(process.env.PORT || process.env.LOCAL_PORT || 5173);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

function buildApp() {
  console.log('Building public/index.html...');
  const result = spawnSync(process.execPath, ['build.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function safeResolve(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const requestedPath = cleanPath || 'index.html';
  const resolved = path.resolve(publicDir, requestedPath);
  return resolved.startsWith(publicDir) ? resolved : null;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024 * 5) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleNetlifyFunction(req, res, pathname) {
  const name = pathname.replace('/.netlify/functions/', '').split('/')[0];
  const functionPath = path.join(rootDir, 'functions', `${name}.js`);

  if (!fs.existsSync(functionPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: `Function not found: ${name}` }));
    return;
  }

  try {
    delete require.cache[require.resolve(functionPath)];
    const mod = require(functionPath);
    const body = await readBody(req);
    const result = await mod.handler({
      httpMethod: req.method,
      path: pathname,
      headers: req.headers,
      body
    });

    res.writeHead(result.statusCode || 200, result.headers || { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(result.body || '');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: err.message }));
  }
}

function handleRequest(req, res) {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  const pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname.startsWith('/.netlify/functions/')) {
    handleNetlifyFunction(req, res, pathname);
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  let filePath = safeResolve(req.url);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    filePath = path.join(publicDir, 'index.html');
  }

  sendFile(res, filePath);
}

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

async function findFreePort(startPort, maxAttempts = 20) {
  for (let offset = 0; offset <= maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await isPortFree(port)) return port;
    console.warn(`Port ${port} is already in use.`);
  }
  throw new Error(`No free port found from ${startPort} to ${startPort + maxAttempts}.`);
}

async function main() {
  buildApp();
  const port = await findFreePort(preferredPort);
  const server = http.createServer(handleRequest);
  server.listen(port, () => {
    console.log('');
    console.log(`Local app is running: http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
