const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { verifySessionToken, getBearerToken } = require('./auth-utils');
const model = require('../public/inspection-model');
const PREFIX = 'vehicle_inspection:';
const BUCKET = 'vehicle-inspections';
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const json = (code, value) => ({ statusCode: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });

function createHandler(db) {
  const load = async id => {
    if (!validId(id)) throw new Error('รหัสแบบตรวจไม่ถูกต้อง');
    const result = await db.from('settings').select('value').eq('key', PREFIX + id).maybeSingle();
    if (result.error) throw result.error;
    return result.data ? { raw: result.data.value, record: JSON.parse(result.data.value) } : null;
  };
  const canEdit = (record, actor) => record.state === 'draft' && (record.createdById === actor.id || actor.role === 'admin');
  return async event => {
    try {
      let actor;
      try { actor = verifySessionToken(getBearerToken(event)); } catch (_) { return json(401, { success: false, message: 'กรุณาเข้าสู่ระบบใหม่' }); }
      if (!['admin', 'manager', 'user'].includes(actor.role)) return json(403, { success: false, message: 'ไม่มีสิทธิ์' });
      const query = event.queryStringParameters || {};
      if (event.httpMethod === 'GET') {
        if (query.action === 'qr') {
          const plate = String(query.plate || '').trim();
          const { data, error } = await db.from('buses').select('plate').eq('plate', plate).maybeSingle();
          if (error || !data) throw new Error('ไม่พบทะเบียนรถ');
          // QR contains only a plate. It grants no permissions and is valid in Local and production.
          return json(200, { success: true, plate, image: await QRCode.toDataURL(plate, { width: 400, margin: 3 }) });
        }
        if (query.id) {
          const found = await load(query.id);
          if (!found) return json(404, { success: false, message: 'ไม่พบแบบตรวจ' });
          const record = found.record;
          const attachments = await Promise.all((record.attachments || []).map(async attachment => {
            const result = await db.storage.from(BUCKET).createSignedUrl(attachment.path, 3600);
            return { ...attachment, url: result.data?.signedUrl || '' };
          }));
          return json(200, { success: true, record: { ...record, attachments }, canEdit: canEdit(record, actor) });
        }
        const records = [];
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await db.from('settings').select('value').like('key', PREFIX + '%').order('key').range(offset, offset + 99);
          if (error) throw error;
          for (const row of data || []) {
            const record = JSON.parse(row.value);
            records.push({ id: record.id, number: record.number, plate: record.plate, inspectedAt: record.inspectedAt, route: record.route, driver1: record.driver1,
              inspector: record.inspector, state: record.state, updatedAt: record.updatedAt, ...model.summary(record) });
          }
          if (!data || data.length < 100) break;
        }
        return json(200, { success: true, records: records.sort((a, b) => b.inspectedAt.localeCompare(a.inspectedAt) || b.updatedAt.localeCompare(a.updatedAt)) });
      }
      if (event.httpMethod !== 'POST') return json(405, { success: false });
      const body = JSON.parse(event.body || '{}');
      if (!validId(body.id)) throw new Error('รหัสแบบตรวจไม่ถูกต้อง');
      const found = await load(body.id);
      if (found && !canEdit(found.record, actor)) return json(403, { success: false, message: 'แบบตรวจส่งผลแล้ว หรือคุณไม่ใช่เจ้าของแบบร่าง' });
      if (body.action === 'upload') {
        const allowedTargets = [...model.getTemplate(found ? (found.record.templateVersion || 'daily-v1') : body.templateVersion).map(item => item.id), 'front', 'back', 'left', 'right', 'general', 'signature-driver', 'signature-inspector', 'signature-supervisor'];
        if (!allowedTargets.includes(body.target)) throw new Error('ตำแหน่งรูปไม่ถูกต้อง');
        const buffer = Buffer.from(String(body.base64 || ''), 'base64');
        const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
        if ((!png && !jpeg) || buffer.length > 1024 * 1024) throw new Error('รองรับรูป JPG/PNG ไม่เกิน 1 MB');
        const bucket = await db.storage.getBucket(BUCKET);
        if (!bucket.data) {
          const result = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 1048576, allowedMimeTypes: ['image/jpeg', 'image/png'] });
          if (result.error && !/already|exist|duplicate/i.test(result.error.message)) throw result.error;
        }
        const path = `${actor.id}/${body.id}/${crypto.randomUUID()}.${png ? 'png' : 'jpg'}`;
        const result = await db.storage.from(BUCKET).upload(path, buffer, { contentType: png ? 'image/png' : 'image/jpeg', upsert: false });
        if (result.error) throw result.error;
        const signed = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
        return json(200, { success: true, attachment: { path, target: body.target, url: signed.data?.signedUrl || '' } });
      }
      if (body.action !== 'save') throw new Error('คำสั่งไม่ถูกต้อง');
      if (found && found.record.revision !== body.revision) return json(409, { success: false, message: 'มีการแก้ไขจากอีกหน้าจอ กรุณาเปิดแบบตรวจใหม่' });
      if (!['draft', 'submitted'].includes(body.state)) throw new Error('สถานะไม่ถูกต้อง');
      const normalized = model.normalize({ ...body.record, templateVersion: found ? (found.record.templateVersion || 'daily-v1') : body.record?.templateVersion }, body.state === 'submitted');
      if (normalized.plate) {
        const result = await db.from('buses').select('plate').eq('plate', normalized.plate).maybeSingle();
        if (result.error || !result.data) throw new Error('กรุณาเลือกทะเบียนที่มีอยู่ในระบบ');
      }
      const attachments = (body.record?.attachments || []).map(attachment => {
        const previous = found?.record.attachments?.some(old => old.path === attachment.path);
        if (!previous && !String(attachment.path).startsWith(`${actor.id}/${body.id}/`)) throw new Error('รูปแนบไม่ถูกต้อง');
        return { path: attachment.path, target: String(attachment.target || 'general').slice(0, 60) };
      });
      if (attachments.length > 20) throw new Error('แนบรูปและลายเซ็นได้ไม่เกิน 20 รูป');
      const now = new Date().toISOString();
      const record = { ...normalized, attachments, id: body.id, number: found?.record.number || `VI-${now.slice(0,10).replace(/-/g,'')}-${body.id.slice(0,8).toUpperCase()}`,
        state: body.state, revision: (found?.record.revision || 0) + 1, createdById: found?.record.createdById || actor.id,
        createdBy: found?.record.createdBy || actor.name, createdAt: found?.record.createdAt || now, updatedAt: now,
        submittedAt: body.state === 'submitted' ? now : '', submittedBy: body.state === 'submitted' ? actor.name : '' };
      const payload = { key: PREFIX + body.id, value: JSON.stringify(record), updated_at: now };
      if (found) {
        const result = await db.from('settings').update(payload).eq('key', payload.key).eq('value', found.raw).select('key');
        if (result.error) throw result.error;
        if (!result.data?.length) return json(409, { success: false, message: 'ข้อมูลถูกแก้ไขพร้อมกัน กรุณาเปิดใหม่' });
      } else {
        const result = await db.from('settings').insert(payload);
        if (result.error) throw result.error;
      }
      return json(200, { success: true, id: record.id, revision: record.revision, number: record.number });
    } catch (error) { return json(400, { success: false, message: error.message }); }
  };
}
exports.createHandler = createHandler;
exports.handler = event => createHandler(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY))(event);
