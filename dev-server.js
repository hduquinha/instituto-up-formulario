// Simple static file server for the landing page
// Usage: node dev-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || process.env.PORT || 5173;
const root = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers={}) {
  res.writeHead(status, Object.assign({'Cache-Control':'no-store'}, headers));
  if(body && body.pipe) return body.pipe(res);
  res.end(body);
}

const server = http.createServer((req,res)=>{
  const urlPath = decodeURIComponent(req.url.split('?')[0].replace(/\\+/g,' '));
  let filePath = path.join(root, urlPath === '/' ? '/index.html' : urlPath);
  if(!filePath.startsWith(root)) return send(res,403,'Forbidden');
  fs.stat(filePath,(err,stat)=>{
    if(err){ return send(res,404,'Not found'); }
    if(stat.isDirectory()) filePath = path.join(filePath,'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const stream = fs.createReadStream(filePath);
    stream.on('error', ()=> send(res,500,'Internal error'));
    send(res,200,stream,{'Content-Type': MIME[ext] || 'application/octet-stream'});
  });
});

server.listen(PORT, ()=>{
  console.log(`Dev server running: http://localhost:${PORT}`);
  console.log('Press CTRL+C to stop');
});
