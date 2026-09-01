// test/dev-server.js — 로컬 통합 테스트용. Vercel 배포와 무관.
// 정적 파일 + 인메모리 /api/state (실제 api/state.js 핸들러 재사용)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/state.js');

process.env.KV_REST_API_URL = 'http://local-stub';
process.env.KV_REST_API_TOKEN = 'stub';
const store = {};
global.fetch = async (url, opts) => {
  const cmd = JSON.parse(opts.body);
  let result = null;
  if (cmd[0] === 'GET') result = store[cmd[1]] ?? null;
  if (cmd[0] === 'SET') { store[cmd[1]] = cmd[2]; result = 'OK'; }
  return { ok: true, json: async () => ({ result }) };
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/state')) {
    let raw = '';
    for await (const ch of req) raw += ch;
    const vres = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { res.statusCode = c; return this; },
      json(o) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return this; }
    };
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    return handler({ method: req.method, query, body: raw ? JSON.parse(raw) : undefined }, vres);
  }
  const pathname = new URL(req.url, 'http://x').pathname;
  const p = path.join(__dirname, '..', pathname === '/' ? 'index.html' : pathname);
  fs.readFile(p, (e, buf) => {
    if (e) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(process.argv[2] || 8787);
console.log('dev server on http://localhost:' + (process.argv[2] || 8787));
