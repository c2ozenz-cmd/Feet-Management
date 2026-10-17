const { createClient } = require('@supabase/supabase-js');
const { verifySessionToken, getBearerToken } = require('./auth-utils');
const { createQueue } = require('./lib/po-notifications');

exports.handler = async event => {
  const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const actor = verifySessionToken(getBearerToken(event));
    if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { success: false });
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const queue = createQueue(db);
    if (event.httpMethod === 'POST') {
      if (actor.role !== 'admin') return json(403, { success: false, message: 'เฉพาะ Admin' });
      const { id } = JSON.parse(event.body || '{}');
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return json(400, { success: false, message: 'รหัสคิวไม่ถูกต้อง' });
      await queue.retry(id);
      let warning = '';
      try { await queue.dispatch(id); } catch (_) { warning = 'บันทึกคิวแล้ว ระบบจะลองส่งผ่านงานตรวจค้าง'; }
      return json(200, { success: true, warning });
    }
    const items = (await queue.list()).flatMap(job => job.items.map(item => ({
      poNo: item.poNo, jobId: job.id, status: item.status, error: item.error || job.error || '', createdAt: job.createdAt
    })));
    return json(200, { success: true, items });
  } catch (error) { return json(400, { success: false, message: error.message }); }
};
