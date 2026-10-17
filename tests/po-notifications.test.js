const assert = require('node:assert/strict');
const { createQueue } = require('../functions/lib/po-notifications');

function memoryDB(seed) {
  const tables = { settings: [{ key: 'LINE_GROUP_ID_PO', value: 'test-group' }], purchase_orders: seed, line_logs: [] };
  return {
    tables,
    from(table) {
      const filters = []; let operation = 'read', payload, one = false, range;
      const query = {
        select() { return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        like(key, value) { filters.push(row => row[key].startsWith(value.replace('%', ''))); return this; },
        range(start, end) { range = [start, end]; return this; },
        maybeSingle() { one = true; return this; },
        single() { one = true; return this; },
        insert(value) { operation = 'insert'; payload = value; return this; },
        upsert(value) { operation = 'upsert'; payload = value; return this; },
        update(value) { operation = 'update'; payload = value; return this; },
        then(resolve, reject) {
          try {
            let rows = tables[table].filter(row => filters.every(filter => filter(row)));
            if (operation === 'insert') {
              if (table === 'settings' && tables.settings.some(row => row.key === payload.key)) return Promise.resolve({ error: new Error('Duplicate key') }).then(resolve);
              tables[table].push(structuredClone(payload)); rows = [payload];
            }
            if (operation === 'update') rows.forEach(row => Object.assign(row, structuredClone(payload)));
            if (operation === 'upsert') {
              const existing = tables[table].find(row => row.key === payload.key);
              if (existing) Object.assign(existing, structuredClone(payload));
              else tables[table].push(structuredClone(payload));
            }
            if (range) rows = rows.slice(range[0], range[1] + 1);
            return Promise.resolve({ data: structuredClone(one ? rows[0] || null : rows), error: null }).then(resolve, reject);
          } catch (error) { return Promise.reject(error).then(resolve, reject); }
        }
      };
      return query;
    }
  };
}
const response = (status, body = '', accepted = false) => ({ ok: status >= 200 && status < 300, status,
  text: async () => body, headers: { get: key => accepted && key === 'x-line-accepted-request-id' ? 'accepted-id' : null } });

function setup(count, overrides = {}) {
  let clock = 1792200000000;
  const approvedAt = new Date(clock).toISOString();
  const nos = Array.from({ length: count }, (_, index) => `PO${String(index + 1).padStart(8, '0')}`);
  const db = memoryDB(nos.map(po_no => ({ po_no, status: 'อนุมัติแล้ว', approved_at: approvedAt, approved_by: 'Manager' })));
  const calls = [], generated = [];
  const queue = createQueue(db, {
    now: () => clock,
    generate: async poNo => { generated.push(poNo); return `https://test.invalid/${poNo}.pdf`; },
    buildFlex: po => ({ type: 'flex', altText: po.po_no, pdf: po.pdf_url }),
    fetch: async (url, options) => { calls.push({ url, ...structuredClone(options) }); return response(200); },
    ...overrides
  });
  return { db, nos, queue, calls, generated, tick: ms => { clock += ms; },
    start: async () => { const job = await queue.enqueue({ poNos: [...nos].reverse(), approvedAt, approver: 'Manager' }); await queue.activate(job.id); return job.id; } };
}

async function main() {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-only';
  process.env.APP_SESSION_SECRET = 'test-only';
  for (const count of [1, 5, 8, 12]) {
    const test = setup(count), id = await test.start();
    await test.queue.processJob(id);
    assert.equal(test.calls.length, Math.ceil(count / 5));
    assert.deepEqual(test.calls.flatMap(call => JSON.parse(call.body).messages.map(message => message.altText)), test.nos);
    assert.ok(test.calls.every(call => JSON.parse(call.body).messages.length <= 5));
    assert.equal((await test.queue.list())[0].state, 'done');
    await test.queue.processJob(id);
    assert.equal(test.calls.length, Math.ceil(count / 5), 'completed jobs must not resend');
  }
  {
    const test = setup(5), id = await test.start();
    await Promise.all([test.queue.processJob(id), test.queue.processJob(id)]);
    assert.equal(test.calls.length, 1, 'CAS lock must exclude concurrent workers');
  }
  {
    let failures = 1;
    const test = setup(5, { generate: async no => { if (no.endsWith('3') && failures-- > 0) throw new Error('PDF failed'); return `https://test.invalid/${no}.pdf`; } });
    const id = await test.start(); await test.queue.processJob(id);
    assert.equal(JSON.parse(test.calls[0].body).messages.length, 4);
    test.tick(61000); await test.queue.processJob(id);
    assert.equal(JSON.parse(test.calls[1].body).messages.length, 1);
    assert.equal((await test.queue.list())[0].state, 'done');
  }
  {
    const sent = [];
    const test = setup(5, { fetch: async (_, options) => { sent.push(options); if (sent.length === 1) throw new Error('ETIMEDOUT'); return response(409, '', true); } });
    const id = await test.start(); await test.queue.processJob(id);
    test.tick(61000); await test.queue.processJob(id);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].headers['X-Line-Retry-Key'], sent[1].headers['X-Line-Retry-Key']);
    assert.equal(sent[0].body, sent[1].body);
    assert.equal((await test.queue.list())[0].state, 'done');
  }
  {
    let calls = 0;
    const test = setup(5, { fetch: async () => { calls++; return response(429, 'You have reached your monthly limit.'); } });
    const id = await test.start(); await test.queue.processJob(id);
    test.tick(61000); await test.queue.processJob(id);
    assert.equal(calls, 1, 'monthly quota must stop automatic retries');
    assert.equal(test.queue.retryable((await test.queue.list())[0]), false);
    assert.ok((await test.queue.list())[0].items.every(item => item.status === 'line_failed'));
  }
  {
    let calls = 0;
    const test = setup(1, { fetch: async () => { calls++; throw new Error('timeout'); } });
    const id = await test.start();
    for (let index = 0; index < 5; index++) { await test.queue.processJob(id); test.tick(5 * 60000); }
    assert.equal(calls, 3, 'automatic retry limit');
    test.tick(24 * 60 * 60000);
    await assert.rejects(test.queue.retry(id), /เกินช่วง/);
    assert.equal(calls, 3, 'expired retry keys must never be regenerated automatically');
  }
  {
    const test = setup(1);
    const job = await test.queue.enqueue({ poNos: test.nos, approvedAt: test.db.tables.purchase_orders[0].approved_at, approver: 'Manager' });
    await test.queue.processJob(job.id); assert.equal(test.calls.length, 0);
    test.tick(61000); await test.queue.processJob(job.id);
    assert.equal(test.calls.length, 1, 'recover crash after approval but before activation');
  }
  {
    const test = setup(1), id = await test.start();
    test.db.tables.purchase_orders[0].status = 'ปฏิเสธ';
    await test.queue.processJob(id);
    assert.equal(test.calls.length, 0, 'do not send after approval was cancelled');
  }
  {
    const fs = require('node:fs'), vm = require('node:vm');
    const pos = Array.from({ length: 8 }, (_, index) => ({ po_no: `PO${index + 1}`, status: 'รออนุมัติ', created_by: 'Requester', pdf_url: 'old.pdf' }));
    const db = memoryDB(pos);
    db.tables.po_items = pos.map(po => ({ po_no: po.po_no, amount: 100 }));
    const request = { status: 'pending', poNos: pos.map(po => po.po_no), managerName: 'Manager', managerLineUserId: 'test-manager' };
    db.tables.settings.push({ key: 'po_approval:test-token', value: JSON.stringify(request) });
    let pdfCalls = 0, dispatches = 0;
    const realQueue = createQueue(db, { fetch: async () => { dispatches++; return response(202); } });
    const module = { exports: {} };
    const secretURL = process.env.URL;
    process.env.URL = 'https://local-test.invalid';
    vm.runInNewContext(fs.readFileSync(require.resolve('../functions/po-approval'), 'utf8'), {
      module, exports: module.exports, console, process, Date,
      require(name) {
        if (name === '@supabase/supabase-js') return { createClient: () => db };
        if (name === './generate-pdf') return { handler: async () => { pdfCalls++; throw new Error('PDF must not run inside approval'); } };
        if (name === './lib/po-notifications') return { createQueue: () => realQueue };
        throw new Error('Unexpected require: ' + name);
      }
    });
    const event = { httpMethod: 'POST', queryStringParameters: { token: 'test-token' }, body: JSON.stringify({ action: 'approve' }) };
    const responses = await Promise.all([module.exports.handler(event), module.exports.handler(event)]);
    assert.equal(responses.filter(result => result.statusCode === 200).length, 1);
    assert.equal(pdfCalls, 0);
    assert.equal(dispatches, 1);
    assert.equal((await realQueue.list()).length, 1);
    assert.ok(pos.every(po => po.status === 'อนุมัติแล้ว'));
    assert.equal(JSON.parse(db.tables.settings.find(row => row.key === 'po_approval:test-token').value).status, 'approved');
    if (secretURL === undefined) delete process.env.URL; else process.env.URL = secretURL;
  }
  console.log('PASS: 1/5/8/12 POs, ascending batches, worker concurrency, PDF partial failure, timeout + LINE 409, quota stop, retry limit, 24h safety, crash recovery, changed approval');
  console.log('PASS: 8-PO approval completes without synchronous PDF/LINE work; concurrent clicks enqueue once');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
