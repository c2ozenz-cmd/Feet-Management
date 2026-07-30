const { createClient } = require('@supabase/supabase-js');
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

function formatMoney(value) {
  return (parseFloat(value) || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function publicPO(po, items, request) {
  const subtotal = (items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const vatType = po.vat_type || 'none';
  const vat = vatType === 'exclusive' ? subtotal * 0.07 : (vatType === 'inclusive' ? subtotal - (subtotal / 1.07) : 0);
  const grandTotal = vatType === 'exclusive' ? subtotal + vat : subtotal;
  return {
    poNo: po.po_no,
    shopName: po.shop_name || '',
    plate: po.plate || '',
    refRepairNo: po.ref_repair_no || '',
    issueDate: po.issue_date || '',
    status: po.status || '',
    createdBy: po.created_by || '',
    approvedBy: po.approved_by || '',
    approvedAt: po.approved_at || '',
    pdfUrl: request.requesterPdfUrl || po.pdf_url || '',
    itemCount: (items || []).length,
    totalText: formatMoney(grandTotal),
    items: (items || []).slice(0, 8).map(item => ({
      partName: item.part_name || '',
      qty: item.qty || 0,
      unit: item.unit || '',
      amountText: formatMoney(item.amount || 0)
    })),
    request: {
      status: request.status,
      requesterName: request.requesterName || '',
      managerName: request.managerName || '',
      expiresAt: request.expiresAt || ''
    }
  };
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function loadRequest(token) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', `po_approval:${token}`)
    .single();
  if (error || !data?.value) throw Object.assign(new Error('ลิงก์อนุมัติไม่ถูกต้องหรือหมดอายุ'), { statusCode: 404 });
  const request = JSON.parse(data.value);
  if (request.expiresAt && Date.now() > new Date(request.expiresAt).getTime()) {
    request.status = 'expired';
  }
  return request;
}

async function saveRequest(token, request) {
  const { error } = await supabase.from('settings').upsert({
    key: `po_approval:${token}`,
    value: JSON.stringify(request),
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}

async function loadPO(poNo) {
  const [poRes, itemsRes] = await Promise.all([
    supabase.from('purchase_orders').select('*').eq('po_no', poNo).single(),
    supabase.from('po_items').select('*').eq('po_no', poNo)
  ]);
  if (poRes.error || !poRes.data) throw Object.assign(new Error(`ไม่พบ PO ${poNo}`), { statusCode: 404 });
  if (itemsRes.error) throw itemsRes.error;
  return { po: poRes.data, items: itemsRes.data || [] };
}

async function generatePOPdf(poNo) {
  const res = await generatePdfFunction.handler({
    httpMethod: 'GET',
    queryStringParameters: { poNo }
  }, {});
  const body = JSON.parse(res.body || '{}');
  if (res.statusCode < 200 || res.statusCode >= 300 || body.success === false) {
    throw new Error(body.error || body.message || 'สร้าง PDF ไม่สำเร็จ');
  }
  return body.pdfUrl || '';
}

async function handleGet(token) {
  const request = await loadRequest(token);
  const { po, items } = await loadPO(request.poNo);
  return json(200, { success: true, po: publicPO(po, items, request) });
}

async function handlePost(token, body) {
  const request = await loadRequest(token);
  if (request.status !== 'pending') {
    return json(409, { success: false, message: `ลิงก์นี้ถูกใช้งานแล้ว: ${request.status}` });
  }
  if (request.expiresAt && Date.now() > new Date(request.expiresAt).getTime()) {
    request.status = 'expired';
    await saveRequest(token, request);
    return json(410, { success: false, message: 'ลิงก์อนุมัติหมดอายุแล้ว' });
  }

  const action = String(body.action || '').trim().toLowerCase();
  if (!['approve', 'reject'].includes(action)) {
    return json(400, { success: false, message: 'Action ไม่ถูกต้อง' });
  }

  const { po, items } = await loadPO(request.poNo);
  const approverName = request.managerName || '';
  if (!request.managerLineUserId || !approverName) {
    return json(403, { success: false, message: 'ลิงก์นี้ไม่ได้ผูกกับผู้จัดการ' });
  }

  if (!['รออนุมัติ', 'ออกPO'].includes(po.status || '')) {
    return json(409, { success: false, message: `PO ${po.po_no} สถานะปัจจุบัน: ${po.status || '-'}` });
  }
  if (normalizeName(po.created_by) && normalizeName(po.created_by) === normalizeName(approverName)) {
    return json(403, { success: false, message: 'ผู้ขออนุมัติไม่สามารถอนุมัติ PO ของตัวเองได้' });
  }

  const now = new Date().toISOString();
  let pdfUrl = po.pdf_url || '';
  if (action === 'approve') {
    const { error } = await supabase.from('purchase_orders').update({
      status: 'อนุมัติแล้ว',
      approved_by: approverName,
      approved_at: now
    }).eq('po_no', po.po_no);
    if (error) throw error;
    pdfUrl = await generatePOPdf(po.po_no);
  } else {
    const { error } = await supabase.from('purchase_orders').update({
      status: 'ปฏิเสธ',
      approved_by: approverName,
      approved_at: now
    }).eq('po_no', po.po_no);
    if (error) throw error;
  }

  request.status = action === 'approve' ? 'approved' : 'rejected';
  request.actionBy = approverName;
  request.actionAt = now;
  request.pdfUrl = pdfUrl;
  await saveRequest(token, request);

  return json(200, {
    success: true,
    action,
    message: action === 'approve' ? 'อนุมัติ PO เรียบร้อย' : 'ปฏิเสธ PO เรียบร้อย',
    pdfUrl,
    po: publicPO({ ...po, status: action === 'approve' ? 'อนุมัติแล้ว' : 'ปฏิเสธ', approved_by: approverName, approved_at: now, pdf_url: pdfUrl }, items, request)
  });
}

exports.handler = async event => {
  initSupabase();
  try {
    const token = String(event.queryStringParameters?.token || '').trim();
    if (!token) return json(400, { success: false, message: 'Missing token' });
    if (event.httpMethod === 'GET') return await handleGet(token);
    if (event.httpMethod === 'POST') {
      return await handlePost(token, JSON.parse(event.body || '{}'));
    }
    return json(405, { success: false, message: 'Method not allowed' });
  } catch (err) {
    console.error('PO approval error:', err);
    return json(err.statusCode || 500, { success: false, message: err.message || 'ดำเนินการอนุมัติไม่สำเร็จ' });
  }
};
