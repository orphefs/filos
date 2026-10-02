#!/usr/bin/env node
// Static server for the webview harness (no dependencies): http://127.0.0.1:5178/harness/
// Serves only the folders the harness needs, from the repo root, with caching off so a rebuild
// shows up on reload. Bound to loopback.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5178);
const ALLOWED = ['harness', 'dist', 'fixtures', 'schema', 'src'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ts': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${HOST}`).pathname);
  } catch {
    return send(400, 'Bad request');
  }
  if (pathname === '/' || pathname === '/harness') return send(302, '', { Location: '/harness/' });
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = resolve(join(ROOT, pathname));
  const top = file.slice(ROOT.length + 1).split(sep)[0];
  if (!file.startsWith(ROOT + sep) || !ALLOWED.includes(top)) return send(404, 'Not found');

  try {
    const info = await stat(file);
    if (!info.isFile()) return send(404, 'Not found');
    const body = await readFile(file);
    send(200, body, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  } catch {
    send(404, 'Not found');
  }
  console.log(`${res.statusCode} ${req.method} ${pathname}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Filos harness: http://${HOST}:${PORT}/harness/  (Ctrl+C to stop)`);
});
