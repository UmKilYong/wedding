# 공유 웨딩 체크리스트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** localStorage 단독 저장을 Vercel 서버리스 + Upstash Redis 공유 저장으로 전환하고, 데이터 기반 렌더링과 모바일 카드 레이아웃을 도입한다.

**Architecture:** 체크리스트를 구조화된 JSON(`{rev, meta, columns, rows}`)으로 관리한다. `api/state.js`(의존성 0, Upstash REST 직접 호출)가 GET/PUT + rev 기반 낙관적 동시성 제어를 제공한다. 클라이언트(`app.js`)는 JSON을 DOM으로 렌더링하고, 사용자 조작을 op로 만들어 디바운스 PUT, 5초 폴링으로 원격 변경을 반영한다. 마크업/CSS는 항상 배포된 index.html 것이 적용되므로 디자인 변경이 데이터와 독립적이다.

**Tech Stack:** 순수 HTML/CSS/JS(빌드 없음), Vercel Serverless Functions(Node CJS), Upstash Redis REST, 테스트는 Node 내장 `node --test`.

## Global Constraints

- 외부 npm 의존성 금지, package.json 없음(Vercel zero-config 유지).
- 텍스트는 플레인 문자열로 저장, DOM 주입은 textContent로만(HTML 주입 금지).
- doc 크기 상한 256KB(서버에서 413).
- 환경변수: `KV_REST_API_URL`/`KV_REST_API_TOKEN` 또는 `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` 중 존재하는 쌍 사용.
- Redis 키: `wedding-timeline:state`, 값은 `JSON.stringify({rev, doc})`.
- localStorage 키: 신규 `wedding-timeline-v2`(캐시+보류 op), 구 `wedding-timeline-v1`은 부팅 시 삭제.
- 사용자에게 보이는 문구는 한국어.

## File Structure

- `api/state.js` — 서버리스 함수(GET/PUT, CAS). CJS `module.exports`.
- `app.js` — 클라이언트 전부: 순수 로직(applyOp/reapply/progress) + 렌더링 + 동기화 엔진. 하단에 `if (typeof module !== 'undefined') module.exports = {...}`로 순수 로직만 노출(테스트용).
- `index.html` — 마크업 스켈레톤 + CSS 전체 + 시드 JSON(`<script type="application/json" id="seed">`) + `<script src="app.js">`. CSS를 인라인으로 유지해 "HTML로 저장" 스냅샷이 스타일을 유지한다.
- `test/state.test.js` — API 핸들러 테스트(fetch 스텁).
- `test/logic.test.js` — applyOp/reapply/progress 테스트.

---

### Task 1: API 함수 `api/state.js`

**Files:**
- Create: `api/state.js`
- Test: `test/state.test.js`

**Interfaces:**
- Produces: `GET /api/state` → `200 {rev:number, doc:object|null}`; `PUT /api/state` body `{baseRev:number, doc:{rows:[...], ...}}` → `200 {rev}` | `409 {rev, doc}` | `400/405/413/502/503 {error}`. 모든 응답 `Cache-Control: no-store`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/state.test.js`

```js
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
// 인메모리 Redis 흉내: POST body ["GET",key] / ["SET",key,val]
function stubRedis(store) {
  global.fetch = async (url, opts) => {
    const cmd = JSON.parse(opts.body);
    let result = null;
    if (cmd[0] === 'GET') result = store.val ?? null;
    if (cmd[0] === 'SET') { store.val = cmd[2]; result = 'OK'; }
    return { ok: true, json: async () => ({ result }) };
  };
}
function env(on) {
  if (on) { process.env.KV_REST_API_URL = 'https://x'; process.env.KV_REST_API_TOKEN = 't'; }
  else { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
         delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN; }
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
test('Redis 오류 시 502', async () => {
  env(true);
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 502);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/state.test.js` → Expected: FAIL (Cannot find module '../api/state.js')

- [ ] **Step 3: 최소 구현** — `api/state.js`

```js
const KEY = 'wedding-timeline:state';
const MAX_DOC_BYTES = 262144;

function cfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}
async function redis(c, cmd) {
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}
async function current(c) {
  const raw = await redis(c, ['GET', KEY]);
  return raw ? JSON.parse(raw) : { rev: 0, doc: null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();
  if (!c) return res.status(503).json({ error: 'kv-not-configured' });
  try {
    if (req.method === 'GET') return res.status(200).json(await current(c));
    if (req.method === 'PUT') {
      const b = req.body;
      if (!b || typeof b.baseRev !== 'number' || !b.doc || typeof b.doc !== 'object' || !Array.isArray(b.doc.rows))
        return res.status(400).json({ error: 'bad-request' });
      const s = JSON.stringify(b.doc);
      if (Buffer.byteLength(s, 'utf8') > MAX_DOC_BYTES) return res.status(413).json({ error: 'too-large' });
      const cur = await current(c);
      if (cur.rev !== b.baseRev) return res.status(409).json(cur);
      const next = { rev: cur.rev + 1, doc: b.doc };
      await redis(c, ['SET', KEY, JSON.stringify(next)]);
      return res.status(200).json({ rev: next.rev });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    return res.status(502).json({ error: 'kv-error' });
  }
};
```

- [ ] **Step 4: 통과 확인** — Run: `node --test test/state.test.js` → Expected: 전부 PASS
- [ ] **Step 5: Commit** — `git add api test && git commit -m "feat: Upstash Redis 기반 /api/state (GET/PUT, rev CAS)"`

---

### Task 2: 순수 클라이언트 로직 (`app.js`의 코어)

**Files:**
- Create: `app.js` (이 태스크에서는 순수 로직 + module.exports 부분만)
- Test: `test/logic.test.js`

**Interfaces:**
- Produces (Task 3~4가 사용):
  - `applyOp(doc, op) -> doc` (제자리 변형 후 같은 참조 반환; 대상 id 없으면 no-op)
  - `reapply(doc, ops) -> doc`
  - `rowProgress(row) -> {done, total}`
  - `findItem(doc, id) -> {item, cell, row} | null`
  - op 종류: `{t:'check',id,v}` `{t:'text',id,v}` `{t:'key',id,v}` `{t:'tip',rowId,col,v}`
    `{t:'rowLabel',id,field:'label'|'sub',v}` `{t:'meta',field:'title'|'sub'|'foot',v}`
    `{t:'addItem',rowId,col,id,afterId}` `{t:'delItem',id}`
    `{t:'addRow',id}` (label 'D-', sub '', 빈 cells 3개) `{t:'delRow',id}`
    `{t:'reset'}` (전체 checked=false) `{t:'replace',doc}` (deep copy로 전체 교체)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/logic.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyOp, reapply, rowProgress, findItem } = require('../app.js');

function doc() {
  return {
    meta: { title: 'T', sub: 'S', foot: 'F' },
    columns: ['DAY', 'A', 'B', 'C'],
    rows: [{
      id: 'r1', label: 'D-365', sub: '12개월',
      cells: [
        { items: [{ id: 'i1', text: '하나', key: true, checked: false },
                  { id: 'i2', text: '둘', key: false, checked: true }], tip: '팁' },
        { items: [], tip: '' },
        { items: [], tip: '' }
      ]
    }]
  };
}

test('check/text/key/tip/rowLabel/meta', () => {
  const d = doc();
  applyOp(d, { t: 'check', id: 'i1', v: true });
  applyOp(d, { t: 'text', id: 'i1', v: '수정' });
  applyOp(d, { t: 'key', id: 'i2', v: true });
  applyOp(d, { t: 'tip', rowId: 'r1', col: 1, v: '새팁' });
  applyOp(d, { t: 'rowLabel', id: 'r1', field: 'sub', v: '1년' });
  applyOp(d, { t: 'meta', field: 'title', v: '새제목' });
  assert.equal(d.rows[0].cells[0].items[0].checked, true);
  assert.equal(d.rows[0].cells[0].items[0].text, '수정');
  assert.equal(d.rows[0].cells[0].items[1].key, true);
  assert.equal(d.rows[0].cells[1].tip, '새팁');
  assert.equal(d.rows[0].sub, '1년');
  assert.equal(d.meta.title, '새제목');
});
test('없는 id는 no-op (동시 삭제 내성)', () => {
  const d = doc();
  assert.doesNotThrow(() => applyOp(d, { t: 'check', id: 'ghost', v: true }));
  assert.doesNotThrow(() => applyOp(d, { t: 'delItem', id: 'ghost' }));
  assert.doesNotThrow(() => applyOp(d, { t: 'tip', rowId: 'ghost', col: 0, v: 'x' }));
});
test('addItem은 afterId 뒤에, null이면 끝에', () => {
  const d = doc();
  applyOp(d, { t: 'addItem', rowId: 'r1', col: 0, id: 'i3', afterId: 'i1' });
  applyOp(d, { t: 'addItem', rowId: 'r1', col: 1, id: 'i4', afterId: null });
  assert.deepEqual(d.rows[0].cells[0].items.map(i => i.id), ['i1', 'i3', 'i2']);
  assert.equal(d.rows[0].cells[1].items[0].id, 'i4');
  assert.deepEqual(d.rows[0].cells[1].items[0], { id: 'i4', text: '', key: false, checked: false });
});
test('delItem/addRow/delRow/reset/replace', () => {
  const d = doc();
  applyOp(d, { t: 'delItem', id: 'i1' });
  assert.equal(d.rows[0].cells[0].items.length, 1);
  applyOp(d, { t: 'addRow', id: 'r2' });
  assert.equal(d.rows.length, 2);
  assert.equal(d.rows[1].cells.length, 3);
  applyOp(d, { t: 'delRow', id: 'r1' });
  assert.deepEqual(d.rows.map(r => r.id), ['r2']);
  const d2 = doc();
  applyOp(d2, { t: 'reset' });
  assert.equal(d2.rows[0].cells[0].items.every(i => !i.checked), true);
  const seed = doc();
  applyOp(d2, { t: 'replace', doc: seed });
  assert.notEqual(d2.rows, seed.rows); // deep copy
  assert.deepEqual(d2.rows, seed.rows);
});
test('reapply는 ops를 순서대로 적용', () => {
  const d = doc();
  reapply(d, [{ t: 'check', id: 'i1', v: true }, { t: 'text', id: 'i1', v: 'x' }]);
  assert.equal(d.rows[0].cells[0].items[0].checked, true);
  assert.equal(d.rows[0].cells[0].items[0].text, 'x');
});
test('rowProgress/findItem', () => {
  const d = doc();
  assert.deepEqual(rowProgress(d.rows[0]), { done: 1, total: 2 });
  assert.equal(findItem(d, 'i2').item.text, '둘');
  assert.equal(findItem(d, 'nope'), null);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/logic.test.js` → Expected: FAIL
- [ ] **Step 3: 구현** — `app.js` 상단에 순수 로직 작성

```js
'use strict';
function findItem(doc, id) {
  for (const row of doc.rows) for (const cell of row.cells) {
    const item = cell.items.find(i => i.id === id);
    if (item) return { item, cell, row };
  }
  return null;
}
function findRow(doc, id) { return doc.rows.find(r => r.id === id) || null; }
function rowProgress(row) {
  let done = 0, total = 0;
  for (const cell of row.cells) for (const it of cell.items) { total++; if (it.checked) done++; }
  return { done, total };
}
function emptyCells() { return [{ items: [], tip: '' }, { items: [], tip: '' }, { items: [], tip: '' }]; }
function applyOp(doc, op) {
  switch (op.t) {
    case 'check': case 'text': case 'key': {
      const f = findItem(doc, op.id);
      if (f) { if (op.t === 'check') f.item.checked = !!op.v; if (op.t === 'text') f.item.text = op.v; if (op.t === 'key') f.item.key = !!op.v; }
      break;
    }
    case 'tip': { const r = findRow(doc, op.rowId); if (r && r.cells[op.col]) r.cells[op.col].tip = op.v; break; }
    case 'rowLabel': { const r = findRow(doc, op.id); if (r && (op.field === 'label' || op.field === 'sub')) r[op.field] = op.v; break; }
    case 'meta': { if (['title', 'sub', 'foot'].includes(op.field)) doc.meta[op.field] = op.v; break; }
    case 'addItem': {
      const r = findRow(doc, op.rowId);
      if (r && r.cells[op.col] && !findItem(doc, op.id)) {
        const items = r.cells[op.col].items;
        const it = { id: op.id, text: '', key: false, checked: false };
        const at = op.afterId ? items.findIndex(i => i.id === op.afterId) : -1;
        if (at >= 0) items.splice(at + 1, 0, it); else items.push(it);
      }
      break;
    }
    case 'delItem': { const f = findItem(doc, op.id); if (f) f.cell.items.splice(f.cell.items.indexOf(f.item), 1); break; }
    case 'addRow': { if (!findRow(doc, op.id)) doc.rows.push({ id: op.id, label: 'D-', sub: '', cells: emptyCells() }); break; }
    case 'delRow': { const i = doc.rows.findIndex(r => r.id === op.id); if (i >= 0) doc.rows.splice(i, 1); break; }
    case 'reset': { for (const r of doc.rows) for (const c of r.cells) for (const it of c.items) it.checked = false; break; }
    case 'replace': { const copy = JSON.parse(JSON.stringify(op.doc)); doc.meta = copy.meta; doc.columns = copy.columns; doc.rows = copy.rows; break; }
  }
  return doc;
}
function reapply(doc, ops) { for (const op of ops) applyOp(doc, op); return doc; }
if (typeof module !== 'undefined') module.exports = { applyOp, reapply, rowProgress, findItem };
```

- [ ] **Step 4: 통과 확인** — Run: `node --test test/logic.test.js` → Expected: 전부 PASS
- [ ] **Step 5: Commit** — `git add app.js test/logic.test.js && git commit -m "feat: doc 뮤테이션 순수 로직(applyOp/reapply)"`

---

### Task 3: index.html 재작성 (마크업 스켈레톤 + CSS + 시드 JSON)

**Files:**
- Modify: `index.html` (전면 재작성)

**Interfaces:**
- Produces: `#seed`(JSON, `{meta, columns, rows}` — rev 없음), `#board`(렌더 타깃), `#status`, 툴바 버튼 `data-act="reset|addrow|clear|save|print"`, `<script src="app.js" defer>`. CSS 클래스 계약: `.board .bhead .row .day .day-label .day-sub .day-progress .row-tools .cell .cellhead .items .item .item.key .txt .badge .tip .tip-label .tip-txt .tools .add-item .dash .status .status.warn`.

- [ ] **Step 1: 시드 JSON 생성.** 커밋 24b205d의 index.html `<tbody>` 내용을 그대로 다음 규칙으로 변환해 `<script type="application/json" id="seed">`에 넣는다:
  - 행 n(1부터) → `id: "r{n}"`, `label` = `.day-label` 텍스트, `sub` = `.day-sub` 텍스트.
  - 행의 day 아닌 td 3개 → `cells[0..2]`. 각 `<li>` m(1부터) → `{id: "r{n}c{c}i{m}", text: .txt 텍스트, key: li.key 여부, checked: false}`. `.tip-txt` 텍스트 → `cell.tip`(없으면 "").
  - `meta`: `{"title":"웨딩 준비 타임라인","sub":"상견례부터 예식 후까지, 놓치지 않도록","foot":"준비의 순간마다, 하나씩 체크하며 ♡"}`
  - `columns`: `["DAY","결혼식·신혼여행","웨딩패키지·한복·예복","혼수·신혼집·기타"]`
- [ ] **Step 2: 마크업 스켈레톤 작성.** body는 툴바(기존 5버튼 유지) + `#status` + `.mark` + `h1#title` + `p.sub#sub` + `<div class="board" id="board"></div>` + `p.foot#foot` + seed + `<script src="app.js" defer></script>`. h1/sub/foot은 contenteditable 유지하되 내용은 app.js가 채운다.
- [ ] **Step 3: CSS 작성.** 기존 팔레트/타이포 변수 유지. 신규 레이아웃:

```css
/* 데스크톱: 표 모양 grid */
.board{background:var(--paper);border-radius:6px;overflow:hidden;}
.bhead,.row{display:grid;grid-template-columns:132px 1fr 1fr 1fr;}
.bhead>div{background:var(--rose);color:#fff;font-size:13.5px;font-weight:700;padding:14px 18px;}
.bhead>div:first-child{text-align:center;}
.row{border-bottom:1px solid var(--line);}
.row:last-child{border-bottom:none;}
.day{text-align:center;background:#FEFCFA;border-right:1px solid var(--line);padding:20px 10px 16px;}
.cell{padding:16px 18px;}
.cellhead{display:none;}
.day-progress{font-size:11px;color:var(--rose-text);margin-top:6px;}
/* 체크박스 터치 타깃: 22px 박스 + 패딩으로 44px 히트영역 */
.item input[type=checkbox]{width:22px;height:22px;flex:none;cursor:pointer;}
.item{min-height:44px;display:flex;align-items:flex-start;gap:10px;padding:6px 0;position:relative;}
/* 모바일: 카드 스택 */
@media (max-width:760px){
  .bhead{display:none;}
  .board{background:none;overflow:visible;}
  .row{display:block;background:var(--paper);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.04);}
  .day{display:flex;align-items:baseline;gap:10px;text-align:left;border-right:none;border-bottom:1px solid var(--line);padding:14px 16px;border-radius:12px 12px 0 0;}
  .day-progress{margin-left:auto;}
  .cell{padding:12px 16px;}
  .cell.empty{display:none;}
  .cellhead{display:block;font-size:11.5px;font-weight:800;color:var(--tan);margin:0 0 6px;letter-spacing:.03em;}
  .txt{font-size:15px;line-height:1.6;}
}
```
  체크박스 ::after 체크 표시 크기도 22px에 맞게 조정(width 6px, height 12px, margin 3px 0 0 7px 근처로 육안 보정). 인쇄 CSS는 데스크톱 grid 유지 + 툴바/도구 숨김 + `.row{break-inside:avoid}`.
- [ ] **Step 4: 브라우저에서 정적 확인** — 로컬 서버로 열어 렌더 전 스켈레톤이 깨지지 않는지 확인 (아직 app.js DOM부 없음이므로 빈 board 정상).
- [ ] **Step 5: Commit** — `git add index.html && git commit -m "feat: 데이터 기반 스켈레톤 + 시드 JSON + 모바일 카드 CSS"`

---

### Task 4: 렌더링 + 동기화 엔진 (`app.js` DOM부)

**Files:**
- Modify: `app.js` (순수 로직 아래, `typeof document !== 'undefined'` 가드 안)

**Interfaces:**
- Consumes: Task 2의 applyOp/reapply/rowProgress, Task 3의 DOM 계약.
- Produces: 동작 완성. 내부 구조(참고): `state = {doc, rev, pending: [], editingEl: null, remoteBuffer: null}`.

- [ ] **Step 1: 렌더러 작성.** `render(doc)`:
  - `#title/#sub/#foot` textContent 채움(포커스 중이면 건너뜀).
  - `#board`에 `.bhead`(columns) + 행별 `.row[data-id]` 생성. day 칸: `.day-label[contenteditable]`, `.day-sub[contenteditable]`, `.day-progress`("3/8", total 0이면 숨김), `.row-tools`(행 삭제). 셀: `.cellhead`(columns[c+1]) + `ul.items` + 항목 li + `.tip`(tip 있을 때) + `.add-item` 버튼 + 항목 0개면 `.cell`에 `empty` 클래스와 `.dash` 표시.
  - li: `<input type=checkbox>`(checked 반영) + `.txt[contenteditable]`(textContent) + `.badge` + `.tools`(핵심/삭제). li에 `data-id`.
  - 모든 텍스트는 textContent로만 주입.
- [ ] **Step 2: 뮤테이션 헬퍼.** `mutate(op, {rerender=true})`: `applyOp(state.doc, op)` → `state.pending.push(op)` → 필요 시 render(체크 토글·텍스트 입력은 부분 갱신: 체크는 해당 li 클래스/progress만, 텍스트는 재렌더 생략) → `saveSoon()`(400ms 디바운스) → localStorage 캐시 갱신.
- [ ] **Step 3: 이벤트 위임 연결.** change(체크박스 → check op), input(contenteditable → 대상별 text/tip/rowLabel/meta op, 같은 대상 연속 입력은 마지막 op만 유지하도록 pending에서 동일 (t,id,field) op 교체), click(툴바/행/항목 버튼: 기존 동작 동일; clear는 confirm 후 `{t:'replace', doc: seed}` + reset rev 아님 — 일반 저장 흐름), keydown(Enter → addItem afterId), paste(플레인 텍스트), focusin/focusout(editingEl 추적, blur 시 remoteBuffer 있으면 적용).
- [ ] **Step 4: 동기화 엔진.**

```js
async function api(method, body) {
  const r = await fetch('/api/state', {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 503) throw { kind: 'nokv' };
  if (method === 'PUT' && r.status === 409) return { conflict: true, ...(await r.json()) };
  if (!r.ok) throw { kind: 'http', status: r.status };
  return await r.json();
}
```
  - `boot()`: v1 키 삭제 → v2 캐시 로드(있으면 즉시 render) → `GET`. 결과별:
    - `doc:null` → 시드(#seed 파싱, 캐시 doc 있으면 캐시 우선)를 `PUT {baseRev:0}` 후 render.
    - 정상 → `state.doc = server.doc; reapply(pending)` 후 render, pending 있으면 saveSoon.
    - `nokv` → status "서버 저장소 미연결 — Vercel에서 Upstash Redis를 연결하세요. 임시로 이 브라우저에만 저장됩니다."(warn), 로컬 모드.
    - 네트워크 오류 → status "오프라인 — 연결되면 자동 저장됩니다."(warn), 캐시로 동작.
  - `save()`: pending 스냅샷 n개 포함 `PUT {baseRev: state.rev, doc: state.doc}` →
    - 200: `state.rev = rev; pending.splice(0, n)`; status "동기화됨 · HH:MM".
    - conflict: `state.doc = server.doc; state.rev = server.rev; reapply(전체 pending)` 후 즉시 재시도(최대 5회, 초과 시 status warn "동기화 충돌 — 잠시 후 자동 재시도").
    - 오류: status "오프라인 — 연결되면 자동 저장됩니다."(warn), 캐시 유지(다음 폴링 틱에서 pending 있으면 재시도).
  - `poll()` 5초 간격: pending 있으면 save 재시도, 없으면 GET → `rev > state.rev`면 editingEl 있으면 remoteBuffer에 보관, 없으면 적용+render.
  - `beforeunload`: 디바운스 타이머 플러시(fetch keepalive로 PUT 시도).
- [ ] **Step 5: 기존 회귀 테스트** — Run: `node --test test/` → Expected: 전부 PASS (DOM부는 가드로 node에서 미실행)
- [ ] **Step 6: Commit** — `git add app.js && git commit -m "feat: 렌더링 + 서버 동기화 엔진(폴링/충돌 재시도/오프라인 폴백)"`

---

### Task 5: 통합 검증 (목 서버 + 브라우저)

**Files:**
- Create: `test/dev-server.js` (커밋 제외 아님 — 커밋 포함, 로컬 전용 도구)

**Interfaces:**
- Produces: `node test/dev-server.js [port]` — 정적 파일 + 인메모리 `/api/state` (api/state.js와 동일 계약). 실제 api/state.js의 CAS 로직을 redis 스텁으로 재사용:

```js
// test/dev-server.js — 로컬 통합 테스트용. Vercel 배포와 무관.
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
  if (cmd[0] === 'GET') result = store.val ?? null;
  if (cmd[0] === 'SET') { store.val = cmd[2]; result = 'OK'; }
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
    return handler({ method: req.method, body: raw ? JSON.parse(raw) : undefined }, vres);
  }
  const p = path.join(__dirname, '..', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(p, (e, buf) => {
    if (e) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(process.argv[2] || 8787);
console.log('dev server on http://localhost:' + (process.argv[2] || 8787));
```

- [ ] **Step 1: dev-server 작성 후 기동, 브라우저 패널로 시나리오 검증:**
  1. 첫 로드 → 시드 렌더, status "동기화됨".
  2. 체크 → 새로고침 → 유지.
  3. 탭 2개 → 탭A 체크 → 탭B 8초 내 반영.
  4. 텍스트 수정·항목 추가·행 추가/삭제 → 새로고침·타 탭 반영.
  5. 모바일 뷰포트(375px) → 카드 스택, 체크박스 22px, 진행률 표시.
  6. 초기화/저장 내용 지우기/인쇄 동작.
- [ ] **Step 2: 발견된 버그 수정 후 전체 테스트** — Run: `node --test test/*.test.js` → PASS
- [ ] **Step 3: Commit** — `git add -A && git commit -m "test: 로컬 통합 dev-server 및 검증 수정사항"`

---

### Task 6: 배포

**Files:** 없음 (배포 작업)

- [ ] **Step 1:** `vercel deploy` (preview) → preview URL에서 스모크 테스트. Upstash 미연결 상태면 "서버 저장소 미연결" 문구 확인이 곧 정상 동작 확인.
- [ ] **Step 2:** 사용자에게 Vercel 대시보드 → Storage → Upstash Redis 생성 → `wedding-timeline` 연결 안내.
- [ ] **Step 3:** 연결 후 `vercel deploy --prod` → 운영 URL에서 GET/PUT 왕복(체크 → 다른 브라우저 반영) 확인.
- [ ] **Step 4: Commit/기록** — 배포 URL과 확인 결과를 사용자에게 보고.
