const crypto = require('crypto');
const fetch = require('node-fetch');
const { createSessionToken } = require('../auth-utils');

const PREFIX = 'po_notify:';
const MAX_ATTEMPTS = 3;
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const sortNos = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function createQueue(db, options = {}) {
  const now = options.now || Date.now;
  const transport = options.fetch || fetch;
  const generate = options.generate || (async poNo => {
    const response = await require('../generate-pdf').handler({ httpMethod: 'GET', queryStringParameters: { poNo } }, {});
    const result = JSON.parse(response.body || '{}');
    if (response.statusCode !== 200 || !result.pdfUrl) throw new Error(result.error || 'สร้าง PDF ไม่สำเร็จ');
    return result.pdfUrl;
  });
  const buildFlex = options.buildFlex || (po => require('../po-approval').buildPOApprovedStatusFlex(po));

  async function load(id) {
    const { data, error } = await db.from('settings').select('value').eq('key', PREFIX + id).maybeSingle();
    if (error) throw error;
    return data ? { job: JSON.parse(data.value), raw: data.value } : null;
  }
  async function cas(id, before, job) {
    const raw = JSON.stringify(job);
    const { data, error } = await db.from('settings').update({ value: raw, updated_at: new Date(now()).toISOString() })
      .eq('key', PREFIX + id).eq('value', before).select('key');
    if (error) throw error;
    if (!data?.length) throw new Error('คิวกำลังถูกประมวลผล กรุณาลองใหม่ภายหลัง');
    return raw;
  }
  async function enqueue({ id = crypto.randomUUID(), poNos, approvedAt, approver, approvalToken }) {
    const job = {
      id, createdAt: now(), state: 'preparing', approvedAt, approver, approvalToken,
      leaseUntil: 0, nextAt: now(), batches: [],
      items: [...new Set(poNos)].sort(sortNos).map(poNo => ({ poNo, status: 'pending', pdfAttempts: 0 }))
    };
    const { error } = await db.from('settings').insert({ key: PREFIX + id, value: JSON.stringify(job) });
    if (error) throw error;
    return job;
  }
  async function activate(id) {
    const record = await load(id);
    if (!record) throw new Error('ไม่พบคิว');
    record.job.state = 'pending';
    await cas(id, record.raw, record.job);
  }
  async function list() {
    let rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from('settings').select('value').like('key', PREFIX + '%').range(offset, offset + 499);
      if (error) throw error;
      rows.push(...(data || []));
      if (data.length < 500) break;
    }
    return rows.map(row => JSON.parse(row.value));
  }
  async function dispatch(id) {
    const base = (process.env.PO_WORKER_BASE_URL || process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
    if (!base) throw new Error('ไม่พบ URL สำหรับเรียกงานเบื้องหลัง');
    const token = createSessionToken({ id, role: 'po-notify-worker' });
    const response = await transport(`${base}/.netlify/functions/po-notify-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }), timeout: 5000
    });
    if (!response.ok) throw new Error(`เรียกงานเบื้องหลังไม่สำเร็จ (${response.status})`);
  }
  async function processJob(id) {
    const record = await load(id);
    if (!record || record.job.state === 'done' || record.job.leaseUntil > now() || record.job.nextAt > now()) return;
    const job = record.job;
    if (job.state === 'preparing' && now() - job.createdAt < 60000) return;
    job.leaseUntil = now() + 16 * 60 * 1000;
    let raw;
    try { raw = await cas(id, record.raw, job); } catch (_) { return; }
    const save = async () => { raw = await cas(id, raw, job); };
    const started = now();
    try {
      const { data: pos, error } = await db.from('purchase_orders').select('*').in('po_no', job.items.map(item => item.poNo));
      if (error) throw error;
      const poMap = new Map((pos || []).map(po => [po.po_no, po]));
      for (const item of job.items) {
        if (item.status === 'pending' && item.pdfAttempts >= MAX_ATTEMPTS) {
          item.status = 'pdf_failed'; item.error = 'สร้าง PDF ไม่สำเร็จหลังลองครบจำนวนครั้ง กรุณากดลองใหม่';
        }
        if (['sent', 'blocked', 'config_failed'].includes(item.status) || item.batchId || item.pdfAttempts >= MAX_ATTEMPTS) continue;
        if (now() - started > 8 * 60 * 1000) break;
        const po = poMap.get(item.poNo);
        if (!po || !['อนุมัติแล้ว', 'รับของแล้ว'].includes(po.status) || po.approved_at !== job.approvedAt || po.approved_by !== job.approver) {
          item.status = 'blocked'; item.error = 'ข้อมูลอนุมัติเปลี่ยนหรือไม่ครบ กรุณาตรวจสอบ PO'; continue;
        }
        if (item.status === 'ready') continue;
        item.pdfAttempts++;
        await save();
        try {
          item.pdfUrl = await generate(item.poNo);
          item.status = 'ready'; item.error = '';
        } catch (err) { item.status = 'pdf_failed'; item.error = err.message; }
        await save();
      }
      // Freeze recipients, payload and retry keys before the first network call.
      const { data: group, error: groupError } = await db.from('settings').select('value').eq('key', 'LINE_GROUP_ID_PO').maybeSingle();
      if (groupError) throw groupError;
      const ready = job.items.filter(item => item.status === 'ready' && !item.batchId);
      if (ready.length && (!group?.value || !process.env.LINE_CHANNEL_ACCESS_TOKEN)) {
        ready.forEach(item => { item.status = 'config_failed'; item.error = 'ยังไม่ได้ตั้งค่ากลุ่ม PO หรือ LINE token'; });
      } else {
        for (let index = 0; index < ready.length; index += 5) {
          const chunk = ready.slice(index, index + 5);
          const batch = { id: crypto.randomUUID(), attempts: 0, status: 'pending', poNos: chunk.map(item => item.poNo),
            payload: { to: group.value, messages: chunk.map(item => buildFlex({ ...poMap.get(item.poNo), pdf_url: item.pdfUrl })) } };
          chunk.forEach(item => { item.batchId = batch.id; item.status = 'queued'; });
          job.batches.push(batch);
        }
      }
      await save();
      for (const batch of job.batches) {
        if (batch.status === 'sent' || batch.status === 'blocked' || batch.attempts >= MAX_ATTEMPTS || (batch.nextAt || 0) > now()) continue;
        if (batch.poNos.some(poNo => {
          const po = poMap.get(poNo);
          return !po || !['อนุมัติแล้ว', 'รับของแล้ว'].includes(po.status) || po.approved_at !== job.approvedAt || po.approved_by !== job.approver;
        })) {
          batch.status = 'blocked'; batch.error = 'สถานะอนุมัติเปลี่ยน กรุณาตรวจสอบ PO ก่อนส่ง'; continue;
        }
        if (batch.firstAttemptAt && now() - batch.firstAttemptAt >= RETRY_WINDOW) {
          batch.status = 'blocked'; batch.error = 'เกินช่วงป้องกันส่งซ้ำ กรุณาตรวจประวัติ LINE ก่อนส่งด้วยตนเอง';
          continue;
        }
        batch.firstAttemptAt = batch.firstAttemptAt || now();
        batch.attempts++;
        await save();
        try {
          const response = await transport('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, 'X-Line-Retry-Key': batch.id },
            body: JSON.stringify(batch.payload), timeout: 15000
          });
          const body = await response.text();
          const accepted = response.ok || (response.status === 409 && !!response.headers.get('x-line-accepted-request-id'));
          batch.code = response.status;
          batch.status = accepted ? 'sent' : (response.status >= 500 || response.status === 429 ? 'retry' : 'blocked');
          batch.error = accepted ? '' : body;
          if (response.status === 429 && /monthly|quota|limit.*month/i.test(body)) batch.status = 'blocked';
          await db.from('line_logs').insert({ stage: accepted ? 'po_queue_push_success' : 'po_queue_push_failed',
            detail: JSON.stringify({ jobId: job.id, poNos: batch.poNos, code: response.status, error: batch.error }) });
        } catch (err) { batch.status = 'retry'; batch.error = err.message; }
        batch.nextAt = now() + 60000 * (2 ** (batch.attempts - 1));
        await save();
      }
      for (const item of job.items.filter(item => item.batchId)) {
        const batch = job.batches.find(row => row.id === item.batchId);
        item.status = batch.status === 'sent' ? 'sent' : batch.status === 'blocked' || batch.attempts >= MAX_ATTEMPTS ? 'line_failed' : 'queued';
        item.error = batch.error || '';
        if (item.status === 'sent') {
          const result = await db.from('purchase_orders').update({ line_sent_at: new Date(now()).toISOString() }).eq('po_no', item.poNo);
          if (result.error) throw result.error;
        }
      }
      // Repair the request summary too if execution previously stopped after approving the rows.
      if (job.approvalToken && job.items.every(item => poMap.get(item.poNo)?.approved_at === job.approvedAt)) {
        const key = `po_approval:${job.approvalToken}`;
        const { data: requestRow, error: requestError } = await db.from('settings').select('value').eq('key', key).maybeSingle();
        if (requestError) throw requestError;
        if (requestRow) {
          const request = JSON.parse(requestRow.value);
          request.status = 'approved'; request.notificationJobId = id;
          request.lineAutoPushResults = job.items.map(item => ({ poNo: item.poNo, success: item.status === 'sent', message: item.error || item.status }));
          const result = await db.from('settings').update({ value: JSON.stringify(request) }).eq('key', key).eq('value', requestRow.value);
          if (result.error) throw result.error;
        }
      }
      job.state = job.items.every(item => item.status === 'sent') ? 'done' : 'pending';
      job.error = '';
    } catch (err) { job.error = err.message; }
    finally {
      job.leaseUntil = 0; job.nextAt = now() + 60000;
      await save();
    }
  }
  function retryable(job) {
    return job.items.some(item => ['pending', 'ready'].includes(item.status) || (item.status === 'pdf_failed' && item.pdfAttempts < MAX_ATTEMPTS))
      || job.items.some(item => item.status === 'queued' && job.batches.some(batch => batch.id === item.batchId && (['sent', 'blocked'].includes(batch.status) || batch.attempts >= MAX_ATTEMPTS)))
      || job.batches.some(batch => !['sent', 'blocked'].includes(batch.status) && batch.attempts < MAX_ATTEMPTS);
  }
  async function retry(id) {
    const record = await load(id);
    if (!record || record.job.state === 'done') return;
    const job = record.job;
    if (job.leaseUntil > now()) throw new Error('ระบบกำลังส่ง กรุณารอสักครู่');
    for (const item of job.items) {
      if (['pdf_failed', 'config_failed'].includes(item.status)) { item.status = 'pending'; item.pdfAttempts = 0; }
    }
    for (const batch of job.batches.filter(batch => batch.status !== 'sent')) {
      if (batch.firstAttemptAt && now() - batch.firstAttemptAt >= RETRY_WINDOW) throw new Error('เกินช่วงป้องกันส่งซ้ำ กรุณาตรวจประวัติ LINE ก่อนส่งด้วยตนเอง');
      batch.attempts = 0; batch.nextAt = 0; batch.status = 'pending';
    }
    job.nextAt = now();
    await cas(id, record.raw, job);
  }
  return { enqueue, activate, list, dispatch, processJob, retry, retryable };
}
module.exports = { createQueue, PREFIX };
