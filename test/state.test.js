const { test } = require('node:test');
const assert = require('node:assert');
const handler = require('../api/state.js');

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
// 인메모리 Redis 흉내: POST body ["GET",key] / ["SET",key,val] — 키별 저장
function stubRedis(store) {
  global.fetch = async (url, opts) => {
    const cmd = JSON.parse(opts.body);
    let result = null;
    if (cmd[0] === 'GET') result = store[cmd[1]] ?? (cmd[1] === 'wedding-timeline:state' ? store.val : null) ?? null;
    if (cmd[0] === 'SET') { store[cmd[1]] = cmd[2]; if (cmd[1] === 'wedding-timeline:state') store.val = cmd[2]; result = 'OK'; }
    return { ok: true, json: async () => ({ result }) };
  };
}
function env(on) {
  if (on) { process.env.KV_REST_API_URL = 'https://x'; process.env.KV_REST_API_TOKEN = 't'; }
  else {
    delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}

test('환경변수 없으면 503', async () => {
  env(false);
  const res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
});

test('GET: 데이터 없으면 rev 0 doc null', async () => {
  env(true); stubRedis({});
  const res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.deepEqual(res.body, { rev: 0, doc: null });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('PUT: baseRev 일치 시 저장하고 rev 증가', async () => {
  env(true); const store = {}; stubRedis(store);
  const res = fakeRes();
  await handler({ method: 'PUT', body: { baseRev: 0, doc: { rows: [] } } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { rev: 1 });
  assert.deepEqual(JSON.parse(store.val), { rev: 1, doc: { rows: [] } });
});

test('PUT: baseRev 불일치 시 409 + 현재본 반환', async () => {
  env(true); const store = { val: JSON.stringify({ rev: 3, doc: { rows: [1] } }) }; stubRedis(store);
  const res = fakeRes();
  await handler({ method: 'PUT', body: { baseRev: 1, doc: { rows: [] } } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.rev, 3);
});

test('PUT: 형식 오류 400 / 크기 초과 413 / 그 외 메서드 405', async () => {
  env(true); stubRedis({});
  let res = fakeRes();
  await handler({ method: 'PUT', body: { baseRev: 'x', doc: {} } }, res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  const big = { rows: [], pad: 'x'.repeat(262145) };
  await handler({ method: 'PUT', body: { baseRev: 0, doc: big } }, res);
  assert.equal(res.statusCode, 413);
  res = fakeRes();
  await handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
});

test('sheet 파라미터: 시트별 별도 키, 기본/1은 기존 키 유지', async () => {
  env(true); const store = {}; stubRedis(store);
  let res = fakeRes();
  await handler({ method: 'PUT', query: { sheet: '2' }, body: { baseRev: 0, doc: { rows: ['s2'] } } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(store['wedding-timeline:state:2'], '시트2는 접미사 키에 저장');
  res = fakeRes();
  await handler({ method: 'PUT', query: { sheet: '1' }, body: { baseRev: 0, doc: { rows: ['s1'] } } }, res);
  assert.ok(store['wedding-timeline:state'], '시트1은 기존 키에 저장');
  res = fakeRes();
  await handler({ method: 'GET', query: { sheet: '2' } }, res);
  assert.deepEqual(res.body.doc, { rows: ['s2'] });
  res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.deepEqual(res.body.doc, { rows: ['s1'] });
});

test('sheet 형식 오류는 400', async () => {
  env(true); stubRedis({});
  const res = fakeRes();
  await handler({ method: 'GET', query: { sheet: '../etc' } }, res);
  assert.equal(res.statusCode, 400);
});

test('Redis 오류 시 502', async () => {
  env(true);
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 502);
});
