/* Node.js 18+ 无需 npm install 的静态网页 + JSON API 服务。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const port = Number(process.env.PORT || 5173);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.mp3':'audio/mpeg', '.xml':'application/xml', '.musicxml':'application/xml', '.svg':'image/svg+xml' };
const allowedRoots=['/src/','/samples/','/tests/'];
const allowedFiles=new Set(['/','/index.html','/styles.css','/示例曲谱.musicxml']);
async function main() {
  const {createApi}=await import('./backend/api.mjs');
  const api=await createApi();
  const server=http.createServer((req,res)=>{
    let pathname;
    try {pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);} catch {res.writeHead(400).end('Bad request');return;}
    if (pathname.startsWith('/api/')) {api(req,res,pathname);return;}
    // 禁止泄漏服务源码、模型脚本、配置文件与其他私有目录。
    if (req.method!=='GET'&&req.method!=='HEAD') {res.writeHead(405).end('Method not allowed');return;}
    if (!allowedFiles.has(pathname) && !allowedRoots.some(prefix=>pathname.startsWith(prefix))) {res.writeHead(404).end('Not found');return;}
    const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if (target!==root&&!target.startsWith(root+path.sep)) {res.writeHead(403).end('Forbidden');return;}
    fs.stat(target,(err,stat)=>{
      if (err||!stat.isFile()||!types[path.extname(target)]) {res.writeHead(404).end('Not found');return;}
      res.writeHead(200,{'Content-Type':types[path.extname(target)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      if (req.method==='HEAD') res.end(); else fs.createReadStream(target).pipe(res);
    });
  });
  server.requestTimeout=95000;
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已占用，请访问 http://localhost:${port} 或设置 PORT。`:error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`随音前端 + API：http://localhost:${port}\n健康检查：http://localhost:${port}/api/health\n按 Ctrl+C 关闭服务。`));
}
main().catch(error=>{console.error('启动失败：',error);process.exitCode=1;});
