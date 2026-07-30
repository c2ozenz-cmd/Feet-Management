const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifySessionToken, getBearerToken } = require('./auth-utils');
const generatePdfFunction = require('./generate-pdf');

let supabase;
function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

function appUrl() {
  return (process.env.SITE_URL || process.env.URL || 'https://feetmanagement.netlify.app').replace(/\/$/, '');
}

function normalizePoNos(body) {
  const source = Array.isArray(body.poNos) ? body.poNos : [body.poNo];
  return [...new Set(source
    .map(poNo => String(poNo || '').trim().toUpperCase())
    .filter(Boolean)
  )];
}

function isApprovalReadyStatus(status) {
  return ['รออนุมัติ', 'ออกPO'].includes(status || '');
}

exports.handler = async event => {
  initSupabase();
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { success: false, message: 'Method not allowed' });
  }

  try {
    const actor = verifySessionToken(getBearerToken(event));
    if (event.httpMethod === 'GET') {
      const { data, error } = await supabase
        .from('profiles')
        .select('name,role,line_user_id')
        .in('role', ['admin', 'manager'])
        .eq('status', 'active')
        .neq('line_user_id', '')
        .order('name');
      if (error) throw error;
      return json(200, {
        success: true,
        managers: (data || []).map(row => ({
          name: row.name || '',
          role: row.role || '',
          lineUserId: row.line_user_id || ''
        }))
      });
    }

    const body = JSON.parse(event.body || '{}');
    const poNos = normalizePoNos(body);
    const managerLineUserId = String(body.managerLineUserId || '').trim();
    if (!poNos.length) return json(400, { success: false, message: 'Missing poNo' });
    if (!managerLineUserId) return json(400, { success: false, message: 'กรุณาเลือกผู้จัดการสำหรับลิงก์นี้' });

    const [{ data: poRows, error: poErr }, { data: manager, error: managerErr }] = await Promise.all([
      supabase
      .from('purchase_orders')
      .select('*')
      .in('po_no', poNos),
      supabase
        .from('profiles')
        .select('name,role,line_user_id')
        .eq('line_user_id', managerLineUserId)
        .eq('status', 'active')
        .single()
    ]);
    if (poErr) throw poErr;
    const poByNo = new Map((poRows || []).map(po => [po.po_no, po]));
    const missingNos = poNos.filter(poNo => !poByNo.has(poNo));
    if (missingNos.length) return json(404, { success: false, message: `ไม่พบ PO ${missingNos.join(', ')}` });
    if (managerErr || !manager) return json(404, { success: false, message: 'ไม่พบผู้จัดการจาก Line User ID นี้' });
    if (!['admin', 'manager'].includes(String(manager.role || '').trim().toLowerCase())) {
      return json(403, { success: false, message: 'ผู้ที่เลือกไม่มีสิทธิ์อนุมัติ PO' });
    }
    const selfApprovalNos = poNos.filter(poNo => {
      const po = poByNo.get(poNo);
      return String(po.created_by || '').trim() && String(po.created_by || '').trim() === String(manager.name || '').trim();
    });
    if (selfApprovalNos.length) {
      return json(403, { success: false, message: 'ผู้ขออนุมัติไม่สามารถเป็นผู้อนุมัติ PO เดียวกันได้' });
    }
    const blocked = poNos
      .map(poNo => poByNo.get(poNo))
      .filter(po => !isApprovalReadyStatus(po.status));
    if (blocked.length) {
      return json(409, {
        success: false,
        message: blocked.map(po => `PO ${po.po_no} สถานะปัจจุบัน: ${po.status || '-'}`).join('\n')
      });
    }

    const requesterPdfUrls = {};
    for (const poNo of poNos) {
      const po = poByNo.get(poNo);
      requesterPdfUrls[poNo] = po.pdf_url || '';
      try {
        const pdfRes = await generatePdfFunction.handler({
          httpMethod: 'GET',
          queryStringParameters: { poNo }
        }, {});
        const pdfBody = JSON.parse(pdfRes.body || '{}');
        if (pdfRes.statusCode >= 200 && pdfRes.statusCode < 300 && pdfBody.success !== false) {
          requesterPdfUrls[poNo] = pdfBody.pdfUrl || requesterPdfUrls[poNo];
        }
      } catch (err) {
        console.warn(`Generate requester PDF failed for ${poNo}:`, err.message);
      }
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const request = {
      poNo: poNos[0],
      poNos,
      status: 'pending',
      requesterName: actor.name || poByNo.get(poNos[0])?.created_by || '',
      requesterUsername: actor.username || '',
      managerName: manager.name || '',
      managerLineUserId,
      requesterPdfUrl: requesterPdfUrls[poNos[0]] || '',
      requesterPdfUrls,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    const { error: saveErr } = await supabase.from('settings').upsert({
      key: `po_approval:${token}`,
      value: JSON.stringify(request),
      updated_at: now.toISOString()
    });
    if (saveErr) throw saveErr;

    const approvalUrl = `${appUrl()}/approve-po.html?token=${encodeURIComponent(token)}`;
    return json(200, {
      success: true,
      poNo: request.poNo,
      poNos,
      count: poNos.length,
      approvalUrl,
      expiresAt: request.expiresAt,
      managerName: request.managerName
    });
  } catch (err) {
    console.error('PO approval link error:', err);
    return json(500, { success: false, message: err.message || 'สร้างลิงก์อนุมัติไม่สำเร็จ' });
  }
};
