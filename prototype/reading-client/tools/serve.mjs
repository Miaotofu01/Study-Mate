// 原型用的静态服务器。
//
// 为什么不用 `python3 -m http.server`：它的 "Serving HTTP on …" 是 stdout 的普通 print，
// 经 npm 转一道管道之后变成块缓冲，**那句话根本不会及时出现**——跑 `npm run prototype`
// 的人只看到命令回显，拿不到地址，只能猜。这个脚本自己打印、自己 flush。
// 附带把「端口被占」从一句 Python 回溯换成自动换端口，并把该开的地址直接开掉。
//
//   node prototype/reading-client/tools/serve.mjs [--port 4173] [--no-open]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');           // prototype/reading-client
const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name);
const portArg = flag('--port');
const START_PORT = portArg > -1 ? Number(argv[portArg + 1]) : Number(process.env.PORT || 4173);
const OPEN = flag('--no-open') === -1;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  // 只服务 ROOT 之内的文件：拼出来的绝对路径必须仍以 ROOT 开头
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('403');
    return;
  }
  let info;
  try {
    info = statSync(full);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
    return;
  }
  if (info.isDirectory()) {
    res.writeHead(302, { location: rel.replace(/\/?$/, '/') + 'index.html' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store', // 原型改一版就想看到一版，别让浏览器缓存骗人
  });
  createReadStream(full).pipe(res);
}

function listen(port, attempt = 0) {
  const server = createServer(handler);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 12) {
      process.stdout.write(`端口 ${port} 被占了，换 ${port + 1}\n`);
      listen(port + 1, attempt + 1);
      return;
    }
    process.stderr.write(`起不来：${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    process.stdout.write(
      '\n  阅读端原型已经在跑：\n\n' +
      `    ${url}\n` +
      `    ${url}?variant=B            三栏工作台\n` +
      `    ${url}?variant=C&theme=light 专注模式 · 浅色\n\n` +
      '  切变体：页面底部那条胶囊，或键盘 ← →。\n' +
      '  停掉：Ctrl+C\n\n');
    if (OPEN) {
      // 打不开就算了（无头、容器、没装 xdg-open 都常见），地址已经印在上面了
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try {
        spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
      } catch { /* 忽略 */ }
    }
  });
}

listen(START_PORT);
