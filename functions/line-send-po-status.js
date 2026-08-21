const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const generatePdfFunction = require('./generate-pdf');

let supabase;
function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
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
  const poNo = po.po_no || '';
  const pdfUrl = po.pdf_url || '';
  const approvedAt = formatDateOnlyTH(po.approved_at || new Date());
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
            detailRow('👤 ผู้อนุมัติ', '', po.approved_by || '—'),
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

exports.handler = async event => {
  initSupabase();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const poNo = String(event.queryStringParameters?.poNo || '').trim().toUpperCase();
  if (!poNo) return json(400, { error: 'Missing poNo parameter' });

  try {
    let { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('po_no', poNo)
      .single();
    if (poErr || !po) return json(404, { error: `ไม่พบ PO ${poNo}` });

    const isApprovedStatus = po.status === 'อนุมัติแล้ว';
    const isReceivedAfterApproval = po.status === 'รับของแล้ว' && (po.approved_by || po.approved_at);
    if (!isApprovedStatus && !isReceivedAfterApproval) {
      const message = po.status === 'รับของแล้ว'
        ? `${poNo} อยู่สถานะ "รับของแล้ว" แต่ยังไม่พบข้อมูลผู้อนุมัติ`
        : `${poNo} ยังไม่ได้รับการอนุมัติ สถานะปัจจุบัน: "${po.status || '-'}"`;
      await logLine('line_push_po_status_blocked', {
        method: 'Push',
        msgType: 'PO_STATUS',
        preview: poNo,
        success: false,
        status: po.status || '',
        message
      });
      return json(409, { success: false, message });
    }

    const { data: groupSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'LINE_GROUP_ID_PO')
      .single();
    const groupId = groupSetting?.value || '';
    if (!LINE_CHANNEL_ACCESS_TOKEN || !groupId) {
      await logLine('line_push_po_status_config_missing', {
        method: 'Push',
        msgType: 'PO_STATUS',
        recipient: groupId || 'LINE_GROUP_ID_PO',
        preview: poNo,
        costStatus: 'คิดเงิน',
        success: false
      });
      return json(500, { success: false, message: 'LINE Token or Group ID PO not configured' });
    }

    if (!po.pdf_url) {
      const pdfUrl = await generatePOPdf(poNo);
      if (pdfUrl) po = { ...po, pdf_url: pdfUrl };
    }

    const flexMsg = buildPOApprovedStatusFlex(po);
    const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ to: groupId, messages: [flexMsg] })
    });

    const responseBody = await lineRes.text();
    if (!lineRes.ok) {
      await logLine('line_push_po_status_failed', {
        method: 'Push',
        msgType: 'PO_STATUS',
        recipient: groupId,
        preview: poNo,
        costStatus: 'คิดเงิน',
        code: lineRes.status,
        success: false,
        error: responseBody
      });
      return json(lineRes.status, { success: false, message: responseBody || `LINE API failed: ${lineRes.status}` });
    }

    const nowStr = new Date().toISOString();
    await supabase.from('purchase_orders').update({ line_sent_at: nowStr }).eq('po_no', poNo);
    await logLine('line_push_po_status_success', {
      method: 'Push',
      msgType: 'PO_STATUS',
      recipient: groupId,
      preview: poNo,
      costStatus: 'คิดเงิน',
      code: lineRes.status,
      success: true,
      sentAt: nowStr
    });

    return json(200, { success: true, sentAt: nowStr, pdfUrl: po.pdf_url || '' });
  } catch (err) {
    console.error('Send PO status to LINE Error:', err);
    await logLine('line_push_po_status_error', {
      method: 'Push',
      msgType: 'PO_STATUS',
      recipient: 'LINE_GROUP_ID_PO',
      preview: poNo,
      costStatus: 'คิดเงิน',
      success: false,
      error: err.message
    });
    return json(500, { success: false, message: err.message });
  }
};
