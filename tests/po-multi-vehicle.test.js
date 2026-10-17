const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = require('../public/po-item-context');

const oldNote = 'ใช้กับรถสำรอง';
assert.equal(context.decode(oldNote).note, oldNote);
assert.equal(context.encode({ note: oldNote }), oldNote);
assert.equal(context.decode('@po-item:v1:invalid').note, '@po-item:v1:invalid');
const item = { note: oldNote, plate: '30-4949 สข', refRepairNo: 'REP001' };
assert.deepEqual(context.decode(context.encode(item)), item);

const pos = [
  { po_no: 'OLD', plate: 'A', status: 'รับของแล้ว', issue_date: '2026-10-12', shop_name: 'Shop', ref_repair_no: 'R0' },
  { po_no: 'MULTI', plate: 'หลายคัน', status: 'รับของแล้ว', issue_date: '2026-10-12', shop_name: 'Shop' }
];
const items = [
  { po_no: 'OLD', amount: 500, note: oldNote },
  { po_no: 'MULTI', amount: 100.01, note: context.encode({ plate: 'A', refRepairNo: 'R1' }) },
  { po_no: 'MULTI', amount: 200.02, note: context.encode({ plate: 'B', refRepairNo: 'R2' }) },
  { po_no: 'MULTI', amount: 99.99, note: context.encode({ plate: 'A', refRepairNo: 'R1' }) }
];
const database = { purchase_orders: pos, po_items: items, stock_logs: [] };
const client = { from(table) {
  return { select() { return this; }, eq() { return this; }, then(resolve) { return Promise.resolve({ data: database[table], error: null }).then(resolve); } };
} };
const window = { SUPABASE_URL: 'test', SUPABASE_ANON_KEY: 'test', supabase: { createClient: () => client } };
const sandbox = { window, POItemContext: context, console, Date, Map, Set, Proxy };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/supabase-bridge.js'), 'utf8'), sandbox);
function summary(filter) {
  return new Promise((resolve, reject) => window.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getExpenseSummary(filter));
}
(async () => {
  const all = await summary({});
  assert.equal(all.total, 900.02);
  assert.equal(all.count, 2);
  assert.equal(all.byPlate.find(row => row.plate === 'A').total, 700);
  assert.equal(all.byPlate.find(row => row.plate === 'B').total, 200.02);
  const onlyB = await summary({ plate: 'B' });
  assert.equal(onlyB.total, 200.02);
  assert.equal(onlyB.count, 1);
  assert.equal(onlyB.detail[0].refRepairNo, 'R2');
  const oldOnly = await summary({ plate: 'A' });
  assert.equal(oldOnly.detail.find(row => row.poNo === 'OLD').total, 500);
  const parts = [];
  const repairClient = { from(table) {
    const filters = [];
    let operation = 'select', payload;
    const query = {
      select() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      single() { this.one = true; return this; },
      maybeSingle() { this.one = true; return this; },
      insert(value) { operation = 'insert'; payload = value; return this; },
      update(value) { operation = 'update'; payload = value; return this; },
      delete() { operation = 'delete'; return this; },
      then(resolve) {
        const rows = table === 'repair_parts' ? parts : table === 'purchase_orders' ? [pos[1]] : items.slice(1).map(row => ({ ...row, part_name: 'Same part', qty: row.amount < 100 ? 3 : row.amount < 200 ? 1 : 2 }));
        const matching = rows.filter(row => filters.every(([key, value]) => row[key] === value));
        if (operation === 'insert') parts.push({ ...payload, id: parts.length + 1 });
        if (operation === 'update') matching.forEach(row => Object.assign(row, payload));
        if (operation === 'delete') matching.forEach(row => parts.splice(parts.indexOf(row), 1));
        return Promise.resolve({ data: this.one ? matching[0] || null : matching, error: null }).then(resolve);
      }
    };
    return query;
  } };
  const repairWindow = { ...window, supabase: { createClient: () => repairClient } };
  const bridgeSource = fs.readFileSync(require.resolve('../public/supabase-bridge.js'), 'utf8')
    .replace('  // Define global google.script.run emulation!', '  window.TestBridge = ScriptRunBridge;');
  vm.runInNewContext(bridgeSource, { ...sandbox, window: repairWindow });
  const bridge = new repairWindow.TestBridge();
  await bridge._syncPOPartsToRepair('MULTI');
  assert.equal(parts.find(row => row.repair_no === 'R1').qty, 4);
  assert.equal(parts.find(row => row.repair_no === 'R2').qty, 2);
  await bridge._rollbackPOPartsFromRepair('MULTI');
  assert.equal(parts.length, 0);
  console.log('PASS: old notes, metadata round-trip, multi-vehicle totals, filters and unique PO counts');
  console.log('PASS: receive and rollback same part across separate repair jobs');
})().catch(error => { console.error(error); process.exitCode = 1; });
