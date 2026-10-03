// Disposable browser-test host: production-built assets, exact nginx CSP, local API only.
// This is test infrastructure, not a production server or a provider mock.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=await readFile(path.join(web,'nginx.conf'),'utf8');
const csp=config.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
if(!csp)throw new Error('Production CSP not found');
await readFile(path.join(web,'dist/index.html'));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
 if(req.url?.startsWith('/api/')){
  const upstream=http.request({hostname:'127.0.0.1',port:3000,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:5173'}},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res)});
  upstream.on('error',()=>{res.writeHead(502,{'content-type':'application/json'});res.end('{"error":{"code":"TEST_UPSTREAM_UNAVAILABLE","message":"Disposable test API unavailable"}}')});req.pipe(upstream);return;
 }
 try{
  const url=new URL(req.url||'/','http://127.0.0.1:5173');
  const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file=relative.startsWith('assets/')?path.resolve(web,'dist',relative):path.join(web,'dist/index.html');
  if(!file.startsWith(path.join(web,'dist')+path.sep)){res.writeHead(400);res.end();return}
  const data=await readFile(file);res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','content-security-policy':csp,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'no-store'});res.end(data);
 }catch{res.writeHead(404);res.end()}
});
server.listen(5173,'127.0.0.1',()=>console.log('TEST-ONLY production-built Web ready at 127.0.0.1:5173 with nginx CSP'));
process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());
