const http = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve } = require('node:path');

const port = Number(process.env.SEQEYES_BROWSER_TEST_PORT || 4173);
const root = resolve(__dirname, '..', '..');
const webRoot = join(root, 'web');

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.bseq', 'application/octet-stream'],
]);

function resolveRequestPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0] || '/');
  if (cleanPath === '/favicon.ico') return join(webRoot, 'logo.png');
  const filePath = cleanPath === '/' ? '/index.html' : cleanPath;
  const target = normalize(join(webRoot, filePath));
  if (!target.startsWith(webRoot)) return null;
  return target;
}

const server = http.createServer((req, res) => {
  const target = resolveRequestPath(req.url || '/');
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': mimeTypes.get(extname(target)) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`SeqEyes browser test server listening on http://127.0.0.1:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
