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
      if (!findRow(doc, op.id)) doc.rows.push({ id: op.id, label: 'D-', sub: '', cells: emptyCells() });
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
