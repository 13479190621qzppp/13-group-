const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = __dirname;
const port = Number(process.env.PORT || 5173);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.mp3':'audio/mpeg', '.xml':'application/xml', '.musicxml':'application/xml', '.svg':'image/svg+xml', '.md':'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let target;
  try { target = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  if (target === root) target = path.join(root, 'index.html');
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
    fs.createReadStream(target).pipe(res);
  });
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请访问 http://localhost:${port} 或设置 PORT。` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`随音已启动：${url}\n按 Ctrl+C 关闭服务。`);
  if (process.platform === 'darwin' && process.argv.includes('--open')) {
    const browser = spawn('open', [url], { stdio: 'ignore' });
    browser.on('error', () => console.error(`无法自动打开浏览器，请手动访问 ${url}`));
    browser.on('exit', code => { if (code) console.error(`无法自动打开浏览器，请手动访问 ${url}`); });
  }
});
