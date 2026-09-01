'use strict';

/* ── 순수 로직: doc 뮤테이션 ─────────────────────────────
   doc = { meta:{title,sub,foot}, columns:[4], rows:[{id,label,sub,cells:[{items:[{id,text,key,checked}],tip}]}] } */

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
      if (f) {
        if (op.t === 'check') f.item.checked = !!op.v;
        if (op.t === 'text') f.item.text = op.v;
        if (op.t === 'key') f.item.key = !!op.v;
      }
      break;
    }
    case 'tip': {
      const r = findRow(doc, op.rowId);
      if (r && r.cells[op.col]) r.cells[op.col].tip = op.v;
      break;
    }
    case 'rowLabel': {
      const r = findRow(doc, op.id);
      if (r && (op.field === 'label' || op.field === 'sub')) r[op.field] = op.v;
      break;
    }
    case 'memo': {
      const r = findRow(doc, op.id);
      if (r) r.memo = op.v;
      break;
    }
    case 'meta': {
      if (['title', 'sub', 'foot'].includes(op.field)) doc.meta[op.field] = op.v;
      break;
    }
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
    case 'delItem': {
      const f = findItem(doc, op.id);
      if (f) f.cell.items.splice(f.cell.items.indexOf(f.item), 1);
      break;
    }
    case 'addRow': {
      if (!findRow(doc, op.id)) doc.rows.push({ id: op.id, label: 'D-', sub: '', memo: '', cells: emptyCells() });
      break;
    }
    case 'delRow': {
      const i = doc.rows.findIndex(r => r.id === op.id);
      if (i >= 0) doc.rows.splice(i, 1);
      break;
    }
    case 'reset': {
      for (const r of doc.rows) for (const c of r.cells) for (const it of c.items) it.checked = false;
      break;
    }
    case 'replace': {
      const copy = JSON.parse(JSON.stringify(op.doc));
      doc.meta = copy.meta; doc.columns = copy.columns; doc.rows = copy.rows;
      break;
    }
  }
  return doc;
}

function reapply(doc, ops) { for (const op of ops) applyOp(doc, op); return doc; }

if (typeof module !== 'undefined') module.exports = { applyOp, reapply, rowProgress, findItem };

/* ── 브라우저: 렌더링 + 동기화 ─────────────────────────── */
if (typeof document !== 'undefined') (function () {

  var SHEET = (function () {
    var s = new URLSearchParams(location.search).get('sheet') || '1';
    return /^[A-Za-z0-9-]{1,20}$/.test(s) ? s : '1';
  })();
  document.body.dataset.sheet = SHEET;   // 시트별 테마(CSS 변수) 적용
  var CACHE_KEY = 'wedding-timeline-v2' + (SHEET === '1' ? '' : ':' + SHEET);
  var OLD_KEY = 'wedding-timeline-v1';
  var MSG_OFFLINE = '오프라인 — 연결되면 자동 저장됩니다.';
  var MSG_NOKV = '서버 저장소 미연결 — Vercel에서 Upstash Redis를 연결하세요. 임시로 이 브라우저에만 저장됩니다.';

  var state = { doc: null, rev: 0, pending: [] };
  var mode = 'server';            // 'server' | 'local'
  var editingEl = null;
  var needRender = false;
  var saving = false;
  var saveTimer = null;

  var board = document.getElementById('board');
  var openMemos = new Set();      // 메모 표시 여부(기기 로컬). 첫 렌더 때 내용 있는 행은 자동 열림
  var openMemosInit = false;
  var statusEl = document.getElementById('status');
  var metaEls = { title: document.getElementById('title'), sub: document.getElementById('sub'), foot: document.getElementById('foot') };

  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function stamp() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function setStatus(msg, warn) { statusEl.textContent = msg; statusEl.className = warn ? 'status warn' : 'status'; }
  function seedDoc() { return JSON.parse(document.getElementById('seed').textContent); }

  function updateCache() {
    if (mode === 'local') state.pending = [];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rev: state.rev, doc: state.doc, pending: state.pending })); } catch (e) {}
  }
  function readCache() {
    try { var raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  /* ── 렌더링 ── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function btn(cls, act, label, title) {
    var b = el('button', cls, label);
    b.type = 'button'; b.dataset.act = act;
    if (title) b.title = title;
    return b;
  }

  function buildItem(item) {
    var li = el('li', 'item' + (item.key ? ' key' : '') + (item.checked ? ' done' : ''));
    li.dataset.id = item.id;
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = item.checked;
    if (item.checked) cb.setAttribute('checked', '');
    var txt = el('span', 'txt', item.text);
    txt.contentEditable = 'true';
    var tools = el('span', 'tools');
    tools.appendChild(btn('', 'togglekey', '핵심', '핵심 표시'));
    tools.appendChild(btn('', 'delitem', '삭제', '항목 삭제'));
    li.appendChild(cb); li.appendChild(txt); li.appendChild(el('span', 'badge', '핵심')); li.appendChild(tools);
    return li;
  }

  function buildCell(row, col, doc) {
    var cell = row.cells[col];
    var td = el('div', 'cell' + (cell.items.length === 0 && !cell.tip ? ' empty' : ''));
    td.dataset.col = String(col);
    td.appendChild(el('h3', 'cellhead', doc.columns[col + 1]));
    var ul = el('ul', 'items');
    cell.items.forEach(function (it) { ul.appendChild(buildItem(it)); });
    td.appendChild(ul);
    if (cell.items.length === 0 && !cell.tip) td.appendChild(el('span', 'dash', '—'));
    if (cell.tip) {
      var tip = el('div', 'tip');
      tip.appendChild(el('span', 'tip-label', 'TIP'));
      var tt = el('span', 'tip-txt', cell.tip);
      tt.contentEditable = 'true';
      tip.appendChild(tt);
      td.appendChild(tip);
    }
    td.appendChild(btn('add-item', 'additem', '＋ 항목 추가'));
    return td;
  }

  function buildRow(row, doc) {
    var sec = el('section', 'row');
    sec.dataset.id = row.id;
    var memoText = row.memo || '';
    var day = el('div', 'day');
    var lb = el('div', 'day-label', row.label); lb.contentEditable = 'true'; lb.dataset.field = 'label';
    var sb = el('div', 'day-sub', row.sub); sb.contentEditable = 'true'; sb.dataset.field = 'sub';
    var pg = el('div', 'day-progress');
    var mb = btn('memo-btn' + (memoText ? ' has' : ''), 'togglememo', memoText ? '메모 ●' : '메모');
    var rt = el('div', 'row-tools');
    rt.appendChild(btn('', 'delrow', '행 삭제'));
    day.appendChild(lb); day.appendChild(sb); day.appendChild(pg); day.appendChild(mb); day.appendChild(rt);
    sec.appendChild(day);
    for (var c = 0; c < 3; c++) sec.appendChild(buildCell(row, c, doc));
    var memo = el('div', 'memo');
    memo.appendChild(el('span', 'memo-label', 'MEMO'));
    var mt = el('div', 'memo-txt', memoText);
    mt.contentEditable = 'true';
    memo.appendChild(mt);
    sec.appendChild(memo);
    if (openMemos.has(row.id)) sec.classList.add('memo-open');
    setProgress(pg, row);
    return sec;
  }

  function setProgress(pgEl, row) {
    var p = rowProgress(row);
    pgEl.textContent = p.total ? p.done + '/' + p.total : '';
  }

  function renderAll() {
    var doc = state.doc;
    if (!openMemosInit) {
      openMemosInit = true;
      doc.rows.forEach(function (r) { if (r.memo) openMemos.add(r.id); });
    }
    Object.keys(metaEls).forEach(function (k) {
      if (metaEls[k] !== editingEl) metaEls[k].textContent = doc.meta[k];
    });
    var head = el('div', 'bhead');
    doc.columns.forEach(function (c) { head.appendChild(el('div', '', c)); });
    board.textContent = '';
    board.appendChild(head);
    doc.rows.forEach(function (r) { board.appendChild(buildRow(r, doc)); });
    needRender = false;
  }
  function renderSoonOrNow() {
    if (editingEl) needRender = true; else renderAll();
  }

  /* ── 뮤테이션 ── */
  function coalesceKey(op) {
    if (op.t === 'text' || op.t === 'check' || op.t === 'key') return op.t + ':' + op.id;
    if (op.t === 'rowLabel') return 'rowLabel:' + op.id + ':' + op.field;
    if (op.t === 'memo') return 'memo:' + op.id;
    if (op.t === 'meta') return 'meta:' + op.field;
    if (op.t === 'tip') return 'tip:' + op.rowId + ':' + op.col;
    return null;
  }
  function mutate(op) {
    applyOp(state.doc, op);
    // PUT 비행 중에는 코얼레싱 금지: 비행 중 스냅샷에 포함된 op를 교체하면
    // 성공 시 splice로 함께 제거되어 새 값이 전송되지 않은 채 유실된다.
    var replaced = false;
    if (!saving) {
      var key = coalesceKey(op);
      if (key) {
        for (var i = state.pending.length - 1; i >= 0; i--) {
          if (coalesceKey(state.pending[i]) === key) { state.pending[i] = op; replaced = true; break; }
        }
      }
    }
    if (!replaced) state.pending.push(op);
    updateCache();
    saveSoon();
  }

  /* ── 서버 통신 ── */
  function api(method, body) {
    return fetch('/api/state?sheet=' + SHEET, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      keepalive: method === 'PUT'
    }).then(function (r) {
      if (r.status === 503) throw { kind: 'nokv' };
      if (method === 'PUT' && r.status === 409) return r.json().then(function (j) { j.conflict = true; return j; });
      if (!r.ok) throw { kind: 'http', status: r.status };
      return r.json();
    }, function () { throw { kind: 'net' }; });
  }

  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (mode === 'local' || saving || !state.pending.length) return;
    saving = true;
    var attempt = function (tries) {
      var n = state.pending.length;
      return api('PUT', { baseRev: state.rev, doc: state.doc }).then(function (r) {
        if (r.conflict) {
          state.doc = r.doc; state.rev = r.rev;
          reapply(state.doc, state.pending);
          renderSoonOrNow();
          if (tries > 0) return attempt(tries - 1);
          setStatus('동기화 충돌 — 잠시 후 자동 재시도합니다.', true);
          return null;
        }
        state.rev = r.rev;
        state.pending.splice(0, n);
        setStatus('동기화됨 · ' + stamp());
        return null;
      });
    };
    attempt(5).catch(function (e) {
      if (e && e.kind === 'nokv') { mode = 'local'; setStatus(MSG_NOKV, true); }
      else setStatus(MSG_OFFLINE, true);
    }).then(function () {
      saving = false;
      updateCache();
      if (state.pending.length && mode === 'server') saveSoon();
    });
  }

  function poll() {
    if (mode === 'local' || saving) return;
    if (state.pending.length) { saveNow(); return; }
    api('GET').then(function (r) {
      if (r.doc && r.rev > state.rev) {
        state.rev = r.rev; state.doc = r.doc;
        // GET 응답 대기 중에 생긴 로컬 변경(pending)을 새 doc 위에 재적용
        if (state.pending.length) { reapply(state.doc, state.pending); saveSoon(); }
        renderSoonOrNow();
        updateCache();
        setStatus('동기화됨 · ' + stamp());
      }
    }).catch(function (e) {
      if (e && e.kind === 'nokv') { mode = 'local'; setStatus(MSG_NOKV, true); }
    });
  }

  function boot() {
    try { localStorage.removeItem(OLD_KEY); } catch (e) {}
    document.querySelectorAll('.sheets a').forEach(function (a) {
      a.classList.toggle('active', a.dataset.sheet === SHEET);
    });
    var cache = readCache();
    if (cache && cache.doc) {
      state.doc = cache.doc; state.rev = cache.rev || 0; state.pending = cache.pending || [];
      renderAll();
    }
    api('GET').then(function (r) {
      if (r.doc === null) {
        if (!state.doc) { state.doc = seedDoc(); renderAll(); }
        return api('PUT', { baseRev: r.rev, doc: state.doc }).then(function (put) {
          if (put.conflict) { state.doc = put.doc; state.rev = put.rev; reapply(state.doc, state.pending); renderAll(); }
          else state.rev = put.rev;
          setStatus('동기화됨 · ' + stamp());
          updateCache();
        });
      }
      state.doc = r.doc; state.rev = r.rev;
      if (state.pending.length) { reapply(state.doc, state.pending); saveSoon(); }
      renderAll();
      setStatus('동기화됨 · ' + stamp());
      updateCache();
    }).catch(function (e) {
      if (!state.doc) { state.doc = seedDoc(); renderAll(); }
      if (e && e.kind === 'nokv') { mode = 'local'; setStatus(MSG_NOKV, true); }
      else setStatus(MSG_OFFLINE, true);
      updateCache();
    });
    setInterval(poll, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    window.addEventListener('focus', poll);
  }

  /* ── 이벤트 ── */
  function itemId(target) { var li = target.closest('li.item'); return li ? li.dataset.id : null; }
  function rowId(target) { var sec = target.closest('.row'); return sec ? sec.dataset.id : null; }

  document.addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    var li = e.target.closest('li.item');
    if (!li) return;
    var v = e.target.checked;
    mutate({ t: 'check', id: li.dataset.id, v: v });
    li.classList.toggle('done', v);
    if (v) e.target.setAttribute('checked', ''); else e.target.removeAttribute('checked');
    var sec = li.closest('.row');
    var row = findRow(state.doc, sec.dataset.id);
    if (row) setProgress(sec.querySelector('.day-progress'), row);
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b && b.dataset.act) { onAction(b); return; }
    // 모바일: 항목 줄의 빈 영역 탭 = 체크 토글
    if (window.matchMedia('(pointer: coarse)').matches) {
      var li = e.target.closest('li.item');
      if (li && !e.target.closest('input,button,[contenteditable]')) {
        var cb = li.querySelector('input[type=checkbox]');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  function onAction(b) {
    var act = b.dataset.act;
    if (act === 'additem') {
      var cellEl = b.closest('.cell');
      var id = newId('i');
      mutate({ t: 'addItem', rowId: rowId(b), col: Number(cellEl.dataset.col), id: id, afterId: null });
      renderAll();
      focusItem(id);
    }
    if (act === 'delitem') { mutate({ t: 'delItem', id: itemId(b) }); renderAll(); }
    if (act === 'togglekey') {
      var f = findItem(state.doc, itemId(b));
      if (f) { mutate({ t: 'key', id: f.item.id, v: !f.item.key }); renderAll(); }
    }
    if (act === 'delrow') {
      if (confirm('이 행 전체를 삭제할까요? 모든 기기에서 함께 삭제됩니다.')) {
        mutate({ t: 'delRow', id: rowId(b) }); renderAll();
      }
    }
    if (act === 'addrow') {
      var rid = newId('r');
      mutate({ t: 'addRow', id: rid });
      renderAll();
      var sec = board.querySelector('.row[data-id="' + rid + '"]');
      if (sec) sec.querySelector('.day-label').focus();
    }
    if (act === 'reset') {
      if (confirm('모든 체크를 해제할까요? 모든 기기에 적용됩니다.')) { mutate({ t: 'reset' }); renderAll(); }
    }
    if (act === 'clear') {
      if (confirm('모든 체크와 수정 내용을 지우고 기본 표로 되돌립니다. 모든 기기에 적용됩니다. 계속할까요?')) {
        mutate({ t: 'replace', doc: seedDoc() }); renderAll();
      }
    }
    if (act === 'togglememo') {
      var sec = b.closest('.row');
      var rid2 = sec.dataset.id;
      if (openMemos.has(rid2)) { openMemos.delete(rid2); sec.classList.remove('memo-open'); }
      else {
        openMemos.add(rid2); sec.classList.add('memo-open');
        var mt = sec.querySelector('.memo-txt');
        if (!mt.textContent) mt.focus();
      }
    }
    if (act === 'print') window.print();
    if (act === 'save') downloadSnapshot();
  }

  function focusItem(id) {
    var li = board.querySelector('li.item[data-id="' + id + '"]');
    if (li) li.querySelector('.txt').focus();
  }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.isContentEditable) return;
    var v = t.textContent;
    if (t.classList.contains('txt')) mutate({ t: 'text', id: itemId(t), v: v });
    else if (t.classList.contains('tip-txt')) {
      var cellEl = t.closest('.cell');
      mutate({ t: 'tip', rowId: rowId(t), col: Number(cellEl.dataset.col), v: v });
    }
    else if (t.classList.contains('day-label') || t.classList.contains('day-sub'))
      mutate({ t: 'rowLabel', id: rowId(t), field: t.dataset.field, v: v });
    else if (t.classList.contains('memo-txt')) {
      mutate({ t: 'memo', id: rowId(t), v: v });
      var mb = t.closest('.row').querySelector('.memo-btn');
      mb.textContent = v ? '메모 ●' : '메모';
      mb.classList.toggle('has', !!v);
    }
    else if (t.id === 'title' || t.id === 'sub' || t.id === 'foot')
      mutate({ t: 'meta', field: t.id, v: v });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target.isContentEditable) return;
    e.preventDefault();
    if (e.target.classList.contains('txt')) {
      var cellEl = e.target.closest('.cell');
      var id = newId('i');
      mutate({ t: 'addItem', rowId: rowId(e.target), col: Number(cellEl.dataset.col), id: id, afterId: itemId(e.target) });
      renderAll();
      focusItem(id);
    } else if (e.target.classList.contains('memo-txt')) {
      document.execCommand('insertText', false, '\n');
    } else {
      e.target.blur();
    }
  });

  document.addEventListener('paste', function (e) {
    if (!e.target.isContentEditable) return;
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });

  document.addEventListener('focusin', function (e) {
    if (e.target.isContentEditable) editingEl = e.target;
  });
  document.addEventListener('focusout', function (e) {
    if (e.target === editingEl) {
      editingEl = null;
      setTimeout(function () { if (!editingEl && needRender) renderAll(); }, 120);
    }
  });

  window.addEventListener('beforeunload', function () {
    if (saveTimer) { clearTimeout(saveTimer); saveNow(); }
  });

  function downloadSnapshot() {
    document.querySelectorAll('input[type=checkbox]').forEach(function (c) {
      if (c.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
    });
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script').forEach(function (s) { s.remove(); });
    clone.querySelectorAll('.toolbar,.status').forEach(function (s) { s.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (s) { s.removeAttribute('contenteditable'); });
    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '웨딩-준비-타임라인.html';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  boot();
})();
