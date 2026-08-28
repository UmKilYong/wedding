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
