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

exports.handler = async (event, context) => {
  initSupabase();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const poNo = event.queryStringParameters?.poNo;
  if (!poNo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing poNo parameter' }) };
  }

  try {
    // 1. Fetch PO and items
    let { data: po, error: poErr } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
    if (poErr || !po) {
      return { statusCode: 404, body: JSON.stringify({ error: 'PO not found: ' + (poErr?.message || '') }) };
    }

    const { data: items } = await supabase.from('po_items').select('*').eq('po_no', poNo);

    // 2. Get LINE Group ID from settings
    const { data: groupSetting } = await supabase.from('settings').select('value').eq('key', 'LINE_GROUP_ID_PO').single();
    const groupId = groupSetting?.value || '';

    if (!LINE_CHANNEL_ACCESS_TOKEN || !groupId) {
      await logLine('line_push_po_config_missing', {
        method: 'Push',
        msgType: 'PO',
        recipient: groupId || 'LINE_GROUP_ID_PO',
        preview: `PO ${poNo}`,
        costStatus: 'คิดเงิน',
        code: 500,
        success: false
      });
      return { statusCode: 500, body: JSON.stringify({ error: 'LINE Token or Group ID PO not configured' }) };
    }

    // 3. Generate requester-signed PDF before sending approval request.
    const pdfResult = await generatePOPdf(poNo);
    if (pdfResult.pdfUrl) {
      po = { ...po, pdf_url: pdfResult.pdfUrl };
    }

    // 4. Build PO Flex Message
    const flexMsg = buildPOFlexMessage(po, items || []);

    // 5. Send Push to LINE group
    const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to: groupId,
        messages: [flexMsg]
      })
    });

    if (!lineRes.ok) {
      const lineErrText = await lineRes.text();
      await logLine('line_push_po_failed', {
        method: 'Push',
        msgType: 'PO',
        recipient: groupId,
        preview: `PO ${po.po_no} | ${po.shop_name || ''}`,
        costStatus: 'คิดเงิน',
        code: lineRes.status,
        success: false,
        error: lineErrText
      });
      throw new Error(`LINE API failed: ${lineRes.status} - ${lineErrText}`);
    }

    // 6. Update sent timestamp in DB
    const nowStr = new Date().toISOString();
    await supabase.from('purchase_orders').update({ line_sent_at: nowStr }).eq('po_no', poNo);
    await logLine('line_push_po_success', {
      method: 'Push',
      msgType: 'PO',
      recipient: groupId,
      preview: `PO ${po.po_no} | ${po.shop_name || ''}`,
      costStatus: 'คิดเงิน',
      code: lineRes.status,
      success: true,
      sentAt: nowStr
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sentAt: nowStr })
    };

  } catch (err) {
    console.error('Send PO to LINE Error:', err);
    await logLine('line_push_po_error', {
      method: 'Push',
      msgType: 'PO',
      recipient: 'LINE_GROUP_ID_PO',
      preview: `PO ${poNo}`,
      costStatus: 'คิดเงิน',
      code: 500,
      success: false,
      error: err.message
    });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

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
  try {
    const res = await generatePdfFunction.handler({
      httpMethod: 'GET',
      queryStringParameters: { poNo }
    }, {});
    const json = JSON.parse(res.body || '{}');
    const success = res.statusCode >= 200 && res.statusCode < 300 && json.success !== false;
    await logLine('line_push_po_pdf_result', {
      poNo,
      success,
      code: res.statusCode,
      pdfUrl: json.pdfUrl || '',
      error: json.error || json.message || ''
    });
    return { success, pdfUrl: json.pdfUrl || '' };
  } catch (err) {
    await logLine('line_push_po_pdf_error', { poNo, success: false, error: err.message });
    return { success: false, pdfUrl: '' };
  }
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

function truncateText(value, maxLength = 26) {
  const text = String(value || '-');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function detailRow(icon, label, value) {
  const safeLabel = label || ' ';
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: icon, size: 'xs', flex: 0 },
      { type: 'text', text: safeLabel, size: 'xs', color: '#6B7280', flex: 3 },
      { type: 'text', text: String(value || '-'), size: 'xs', color: '#111827', align: 'end', wrap: true, flex: 5, weight: 'bold' }
    ]
  };
}

function buildPOFlexMessage(po, items) {
  const safeItems = items || [];
  const subtotal = safeItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const vatType = po.vat_type || 'none';
  const vat = vatType === 'exclusive' ? subtotal * 0.07 : (vatType === 'inclusive' ? subtotal - (subtotal / 1.07) : 0);
  const grandTotal = vatType === 'exclusive' ? subtotal + vat : subtotal;
  const pdfUrl = po.pdf_url || po.pdfUrl || '';
  const itemPreview = safeItems.slice(0, 4).map(item => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'xs',
    contents: [
      { type: 'text', text: '•', size: 'xs', color: '#111827', flex: 0 },
      { type: 'text', text: truncateText(item.part_name, 30), size: 'xs', color: '#111827', wrap: true, flex: 6 },
      { type: 'text', text: `${formatMoney(item.qty).replace('.00', '')} ${item.unit || ''}`.trim(), size: 'xs', color: '#374151', align: 'end', flex: 2 }
    ]
  }));
  if (safeItems.length > 4) {
    itemPreview.push({ type: 'text', text: `และอีก ${safeItems.length - 4} รายการ`, size: 'xxs', color: '#6B7280', margin: 'xs' });
  }

  return {
    type: 'flex',
    altText: `ขออนุมัติใบสั่งซื้อ ${po.po_no}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1E3A5F',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '📋', size: 'xxl', flex: 0 },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'sm',
                contents: [
                  { type: 'text', text: 'ขออนุมัติใบสั่งซื้อ', weight: 'bold', size: 'lg', color: '#FFFFFF' },
                  { type: 'text', text: po.po_no, size: 'sm', color: '#D7E5F4', margin: 'xs' }
                ]
              }
            ]
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#FFF7ED',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: '💰 ยอดรวมทั้งสิ้น', size: 'xxs', color: '#C76A00', weight: 'bold' },
                  { type: 'text', text: `${formatMoney(grandTotal)} บาท`, size: 'lg', color: '#F97316', weight: 'bold', margin: 'xs' }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: 'จำนวนรายการ', size: 'xxs', color: '#C76A00', weight: 'bold', align: 'end' },
                  { type: 'text', text: `${safeItems.length} รายการ`, size: 'lg', color: '#F97316', weight: 'bold', align: 'end', margin: 'xs' }
                ]
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              detailRow('🏪', 'ร้านค้า', po.shop_name || '-'),
              detailRow('🚌', 'ทะเบียน', po.plate || '-'),
              detailRow('🔧', 'อ้างอิงซ่อม', po.ref_repair_no || '-'),
              detailRow('🗓️', 'วันที่', formatDateOnlyTH(po.issue_date)),
              detailRow('👤', 'ผู้ขอ', po.created_by || '-')
            ]
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '📦 รายการสินค้า', size: 'sm', weight: 'bold', color: '#374151' },
              ...(itemPreview.length ? itemPreview : [{ type: 'text', text: 'ไม่มีรายการสินค้า', size: 'xs', color: '#6B7280' }])
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
            type: 'button',
            style: 'primary',
            color: '#10B981',
            height: 'sm',
            action: { type: 'postback', label: '✅ อนุมัติ', data: `action=approve&type=po&id=${po.po_no}`, displayText: `✅ อนุมัติ PO ${po.po_no}` }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#EF4444',
            height: 'sm',
            action: { type: 'postback', label: '❌ ปฏิเสธ', data: `action=reject&type=po&id=${po.po_no}`, displayText: `❌ ปฏิเสธ PO ${po.po_no}` }
          }
            ]
          },
          ...(pdfUrl ? [{
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'uri', label: '📄 ดูใบสั่งซื้อ PDF', uri: pdfUrl }
          }] : [])
        ]
      }
    }
  };
}
