import {createServer} from 'node:http';
import {readFile, realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary'};

export async function resolveAsset(rootPath, raw) {
  const base = await realpath(rootPath);
  let pathname;
  try { pathname = decodeURIComponent(raw.split('?')[0]); }
  catch { throw new Error('Invalid path encoding'); }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid path');
  if (pathname.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden and relative paths are not served');
  const target = await realpath(resolve(base, '.' + pathname));
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(target)).isFile()) throw new Error('Outside fixture directory or not a file');
  return target;
}

export function makeServer(rootPath = root) {
  return createServer(async (req, res) => {
    const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
    if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405, headers).end(); return;}
    if (req.url === '/__health') {res.writeHead(200, {...headers, 'Content-Type': 'text/plain'}).end('browser-lab'); return;}
    if (req.url === '/favicon.ico') {res.writeHead(204, headers).end(); return;}
    try {
      const target = await resolveAsset(rootPath, req.url);
      const body = await readFile(target);
      res.writeHead(200, {...headers, 'Content-Type': types[extname(target)] || 'application/octet-stream'});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {res.writeHead(404, headers).end('Not found');}
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = makeServer();
  server.on('error', error => {console.error(error.message); process.exitCode = 1;});
  server.listen(4173, '127.0.0.1', () => console.log('Browser Lab: http://127.0.0.1:4173'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
