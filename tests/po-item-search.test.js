const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = require('../public/po-item-context');
const search = require('../public/po-item-search');
const pos = [
  { po_no: 'PO1', shop_name: 'ร้าน ก', issue_date: '2025-01-01', status: 'รับของแล้ว', plate: '30-1111 สข', ref_repair_no: 'REP1', vat_type: 'exclusive' },
  { po_no: 'PO2', shop_name: 'ร้าน ข', issue_date: '2026-10-01', status: 'อนุมัติแล้ว', plate: 'หลายคัน', vat_type: 'inclusive' }
];
const items = [
  { id: 1, po_no: 'PO1', part_name: 'เปลี่ยนหัวฉีด', note: 'ค่าแรงร้านนอก', amount: 8000, qty: 1 },
  { id: 2, po_no: 'PO1', part_name: 'ค่าตรวจเช็ก', note: 'ระบบไฟ', amount: 2000 },
  { id: 3, po_no: 'PO2', part_name: 'ล้าง INJECTOR', note: context.encode({ plate: '30-2222 สข', refRepairNo: 'REP2', note: 'งานซ่อมภายนอก' }), amount: 1500 },
  { id: 4, po_no: 'PO2', part_name: 'เปลี่ยนเบรค', note: context.encode({ plate: '30-3333 สข', refRepairNo: 'REP3', note: '' }), amount: 500 },
  { id: 5, po_no: 'DELETED', part_name: 'หัวฉีด', amount: 9999 }
];
const rows = search.buildRows(pos, items);
assert.equal(rows.length, 4, 'exclude deleted/orphaned POs');
assert.equal(search.search(rows, { query: 'หัวฉีด' }).length, 2, 'partial Thai search and English synonym across years');
assert.equal(search.search(rows, { query: '  injector   30-2222 ' }).length, 1);
assert.equal(search.search(rows, { query: 'ค่าแรง' })[0].poNo, 'PO1', 'search old free-text notes');
assert.equal(search.search(rows, { query: 'หัวฉีด', plate: '30-3333 สข' }).length, 0, 'never attribute another vehicle item to a match');
assert.equal(search.search(rows, { query: 'เบรก' })[0].partName, 'เปลี่ยนเบรค');
assert.equal(search.search(rows, { query: 'REP2' })[0].plate, '30-2222 สข');
assert.equal(search.search(rows, { from: '2026-01-01', to: '2026-12-31', shopName: 'ร้าน ข', status: 'อนุมัติแล้ว' }).length, 2);
assert.equal(rows.find(row => row.poNo === 'PO1').poTotal, 10700, 'PO total includes every item and exclusive VAT');
assert.equal(rows.find(row => row.poNo === 'PO2').poTotal, 2000, 'inclusive VAT is not added again');
assert.equal(rows.find(row => row.id === 1).refRepairNo, 'REP1', 'legacy header fallback');
assert.equal(rows.find(row => row.id === 3).note, 'งานซ่อมภายนอก', 'metadata must not be visible as raw JSON');
assert.equal(search.search(rows, { query: '<script>' }).length, 0);
assert.equal(search.search(rows, { query: 'zzzz' }).length, 0);

const manyItems = Array.from({ length: 1205 }, (_, index) => ({ ...items[0], id: index + 1 }));
const reads = [];
const client = { from(table) {
  let range = [0, 499];
  return {
    select() { return this; }, order() { return this; },
    range(from, to) { range = [from, to]; return this; },
    then(resolve) {
      reads.push({ table, range });
      return Promise.resolve({ data: (table === 'purchase_orders' ? pos : manyItems).slice(range[0], range[1] + 1), error: null }).then(resolve);
    }
  };
} };
const window = { SUPABASE_URL: 'test', SUPABASE_ANON_KEY: 'test', supabase: { createClient: () => client } };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/supabase-bridge.js'), 'utf8'), { window, POItemSearch: search, console });
new Promise((resolve, reject) => window.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getPOItemHistory())
  .then(result => {
    assert.equal(result.length, 1205, 'fetch beyond Supabase default row limit');
    assert.equal(reads.filter(read => read.table === 'po_items').length, 3);
    console.log('PASS: Thai partial/English aliases, notes, year/date/shop/status filters, per-item plates and jobs, PO VAT totals, deleted rows, pagination beyond 1000 rows');
  }).catch(error => { console.error(error); process.exitCode = 1; });
