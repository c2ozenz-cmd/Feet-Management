const { createClient } = require('@supabase/supabase-js');
const generatePdfFunction = require('./generate-pdf');
const { createQueue } = require('./lib/po-notifications');

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

function formatDateOnlyTH(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function detailRow(icon, label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: icon, size: 'xs', flex: 0 },
      { type: 'text', text: label || ' ', size: 'xs', color: '#6B7280', flex: 3 },
      { type: 'text', text: String(value || '-'), size: 'xs', color: '#111827', align: 'end', wrap: true, flex: 5, weight: 'bold' }
    ]
  };
}

function buildPOApprovedStatusFlex(po) {
  const poNo = po.po_no || po.poNo || '';
  const pdfUrl = po.pdf_url || po.pdfUrl || '';
  const approvedAt = formatDateOnlyTH(po.approved_at || po.approvedAt || new Date());
  const contents = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          backgroundColor: '#1E3A5F',
          cornerRadius: '8px',
          paddingAll: '10px',
          contents: [
            { type: 'text', text: '🚌', size: 'sm', flex: 0 },
            { type: 'text', text: po.plate || 'Stock', size: 'lg', weight: 'bold', color: '#FFFFFF', margin: 'sm' }
          ]
        },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#F0FDF4',
          cornerRadius: '8px',
          paddingAll: '12px',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '📋 รายละเอียดการอนุมัติ', size: 'xs', weight: 'bold', color: '#065F46' },
            detailRow('📄 เลขที่ PO', '', poNo),
            detailRow('👤 ผู้อนุมัติ', '', po.approved_by || po.approvedBy || '—'),
            detailRow('📅 วันที่', '', approvedAt)
          ]
        }
      ]
    }
  };

  if (pdfUrl) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: '#10B981',
          action: { type: 'uri', label: '📄 ดูใบสั่งซื้อ PDF', uri: pdfUrl }
        }
      ]
    };
  }

  return {
    type: 'flex',
    altText: `✅ อนุมัติ PO ${poNo}`,
    contents
  };
}

async function logLine(stage, detail) {
  try {
    await supabase.from('line_logs').insert({
      stage,
      detail: JSON.stringify(detail)
    });
  } catch (err) {
    console.error('LINE log insert failed:', err);
  }
}

function publicPO(po, items, request) {
  const subtotal = (items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const vatType = po.vat_type || 'none';
  const vat = vatType === 'exclusive' ? subtotal * 0.07 : (vatType === 'inclusive' ? subtotal - (subtotal / 1.07) : 0);
  const grandTotal = vatType === 'exclusive' ? subtotal + vat : subtotal;
  const requestPdfUrl = request.requesterPdfUrls?.[po.po_no] || request.requesterPdfUrl || '';
  const pdfUrl = request.status === 'pending' ? (requestPdfUrl || po.pdf_url || '') : (po.pdf_url || requestPdfUrl);
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
    pdfUrl,
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
  if (request.status === 'pending' && request.expiresAt && Date.now() > new Date(request.expiresAt).getTime()) {
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

function getRequestPoNos(request) {
  return (Array.isArray(request.poNos) && request.poNos.length ? request.poNos : [request.poNo])
    .map(poNo => String(poNo || '').trim().toUpperCase())
    .filter(Boolean);
}

function normalizeSelectedPoNos(body, allowedNos) {
  const selected = Array.isArray(body.poNos) && body.poNos.length
    ? body.poNos.map(poNo => String(poNo || '').trim().toUpperCase()).filter(Boolean)
    : allowedNos;
  const allowed = new Set(allowedNos);
  return [...new Set(selected)].filter(poNo => allowed.has(poNo));
}

function comparePONos(a, b) {
  const aNo = String(a?.po_no || a?.poNo || a || '');
  const bNo = String(b?.po_no || b?.poNo || b || '');
  return aNo.localeCompare(bNo, 'en', { numeric: true, sensitivity: 'base' });
}

function isApprovalReadyStatus(status) {
  return ['รออนุมัติ', 'ออกPO'].includes(status || '');
}

async function refreshPendingPreviewPdfs(token, request, poNos) {
  if (request.status !== 'pending' || request.previewPdfVersion === 'wrap-v7') return request;

  const requesterPdfUrls = { ...(request.requesterPdfUrls || {}) };
  for (const poNo of poNos) {
    try {
      const pdfUrl = await generatePOPdf(poNo);
      if (pdfUrl) requesterPdfUrls[poNo] = pdfUrl;
    } catch (err) {
      console.warn(`Refresh approval preview PDF failed for ${poNo}:`, err.message);
    }
  }

  const updatedRequest = {
    ...request,
    requesterPdfUrl: requesterPdfUrls[poNos[0]] || request.requesterPdfUrl || '',
    requesterPdfUrls,
    previewPdfVersion: 'wrap-v7'
  };
  await saveRequest(token, updatedRequest);
  return updatedRequest;
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
  let request = await loadRequest(token);
  const poNos = getRequestPoNos(request);
  request = await refreshPendingPreviewPdfs(token, request, poNos);
  const pos = await Promise.all(poNos.map(async poNo => {
    const { po, items } = await loadPO(poNo);
    return publicPO(po, items, request);
  }));
  return json(200, { success: true, po: pos[0], pos, count: pos.length });
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

  const allowedNos = getRequestPoNos(request);
  const selectedPoNos = normalizeSelectedPoNos(body, allowedNos);
  if (!selectedPoNos.length) {
    return json(400, { success: false, message: 'กรุณาเลือก PO อย่างน้อย 1 ใบ' });
  }

  const approverName = request.managerName || '';
  if (!request.managerLineUserId || !approverName) {
    return json(403, { success: false, message: 'ลิงก์นี้ไม่ได้ผูกกับผู้จัดการ' });
  }

  const now = new Date().toISOString();
  const results = [];
  const publicResults = [];
  const loaded = await Promise.all(selectedPoNos.sort(comparePONos).map(loadPO));
  for (const { po } of loaded) {
    if (!isApprovalReadyStatus(po.status)) {
      return json(409, { success: false, message: `PO ${po.po_no} สถานะปัจจุบัน: ${po.status || '-'}` });
    }
    if (normalizeName(po.created_by) && normalizeName(po.created_by) === normalizeName(approverName)) {
      return json(403, { success: false, message: `ผู้ขออนุมัติไม่สามารถอนุมัติ PO ${po.po_no} ของตัวเองได้` });
    }
  }
  // Claim this link before changing rows; concurrent clicks cannot enqueue a second job.
  const requestKey = `po_approval:${token}`;
  const { data: latest, error: latestError } = await supabase.from('settings').select('value').eq('key', requestKey).single();
  if (latestError) throw latestError;
  if (JSON.parse(latest.value).status !== 'pending') return json(409, { success: false, message: 'คำขอนี้กำลังดำเนินการหรืออนุมัติแล้ว' });
  const processing = { ...request, status: 'processing', actionBy: approverName, actionAt: now, selectedPoNos };
  const { data: claimed, error: claimError } = await supabase.from('settings').update({ value: JSON.stringify(processing) })
    .eq('key', requestKey).eq('value', latest.value).select('key');
  if (claimError) throw claimError;
  if (!claimed?.length) return json(409, { success: false, message: 'คำขอนี้กำลังดำเนินการ' });

  const queue = createQueue(supabase);
  let job;
  try {
    if (action === 'approve') job = await queue.enqueue({ poNos: selectedPoNos, approvedAt: now, approver: approverName, approvalToken: token });
  } catch (error) {
    await supabase.from('settings').update({ value: latest.value }).eq('key', requestKey).eq('value', JSON.stringify(processing));
    throw error;
  }
  const nextStatus = action === 'approve' ? 'อนุมัติแล้ว' : 'ปฏิเสธ';
  const { data: updatedRows, error: updateError } = await supabase.from('purchase_orders').update({
    status: nextStatus, approved_by: approverName, approved_at: now
  }).in('po_no', selectedPoNos).in('status', ['รออนุมัติ', 'ออกPO']).select('po_no');
  if (updateError) throw updateError;
  if (updatedRows.length !== selectedPoNos.length) throw new Error('สถานะ PO บางใบเปลี่ยนระหว่างดำเนินการ กรุณาตรวจสอบรายการ');

  request.status = action === 'approve' ? 'approved' : 'rejected';
  request.notificationJobId = job?.id || '';
  for (const { po, items } of loaded) {
    const pdfUrl = po.pdf_url || '';
    const updatedPO = { ...po, status: nextStatus, approved_by: approverName, approved_at: now, pdf_url: pdfUrl };
    const publicUpdatedPO = publicPO(updatedPO, items, request);
    publicUpdatedPO.pdfUrl = pdfUrl || publicUpdatedPO.pdfUrl;
    results.push({ success: true, poNo: po.po_no, pdfUrl, status: nextStatus });
    publicResults.push(publicUpdatedPO);
  }

  const lineAutoPushResults = [];

  request.status = action === 'approve' ? 'approved' : 'rejected';
  request.actionBy = approverName;
  request.actionAt = now;
  request.selectedPoNos = selectedPoNos;
  request.results = results;
  request.lineAutoPushResults = lineAutoPushResults;
  request.pdfUrl = results[0]?.pdfUrl || '';
  await saveRequest(token, request);
  let notificationWarning = '';
  if (job) {
    try { await queue.activate(job.id); await queue.dispatch(job.id); }
    catch (err) {
      notificationWarning = 'อนุมัติแล้ว งาน PDF และ LINE อยู่ในคิวรอดำเนินการ';
      await logLine('po_queue_dispatch_deferred', { jobId: job.id, error: err.message });
    }
  }

  return json(200, {
    success: true,
    action,
    message: action === 'approve' ? 'อนุมัติ PO เรียบร้อย' : 'ปฏิเสธ PO เรียบร้อย',
    pdfUrl: results[0]?.pdfUrl || '',
    results,
    lineAutoPushResults,
    notificationQueued: !!job,
    notificationWarning,
    po: publicResults[0],
    pos: publicResults,
    count: publicResults.length
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
exports.buildPOApprovedStatusFlex = buildPOApprovedStatusFlex;
