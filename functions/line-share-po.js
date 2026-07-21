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

exports.handler = async event => {
  initSupabase();
  if (event.httpMethod !== 'GET') {
    return json(405, { success: false, message: 'Method not allowed' });
  }

  const poNo = String(event.queryStringParameters?.poNo || '').trim().toUpperCase();
  if (!poNo) return json(400, { success: false, message: 'Missing poNo parameter' });

  try {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('po_no', poNo)
      .single();
    if (poErr || !po) return json(404, { success: false, message: `PO not found: ${poNo}` });

    const { data: items, error: itemsErr } = await supabase
      .from('po_items')
      .select('*')
      .eq('po_no', poNo);
    if (itemsErr) throw itemsErr;

    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key,value')
      .in('key', ['LINE_LIFF_ID', 'LINE_OA_ID']);
    const settings = {};
    (settingsRows || []).forEach(row => { settings[row.key] = row.value || ''; });

    let pdfUrl = po.pdf_url || '';
    const pdfResult = await generatePOPdf(poNo);
    if (pdfResult.pdfUrl) pdfUrl = pdfResult.pdfUrl;

    const liffId = process.env.LINE_LIFF_ID || settings.LINE_LIFF_ID || '';
    const rawAppUrl = process.env.SITE_URL || process.env.URL || 'https://feetmanagement.netlify.app';
    const appUrl = /^https?:\/\/localhost(?::\d+)?/i.test(rawAppUrl)
      ? 'https://feetmanagement.netlify.app'
      : rawAppUrl.replace(/\/$/, '');
    const liffBaseUrl = liffId ? `https://liff.line.me/${encodeURIComponent(liffId)}` : '';
    const flex = buildSharePOFlex(po, items || [], { pdfUrl, liffBaseUrl, appUrl });
    const shareText = buildShareText(po, items || [], pdfUrl);

    return json(200, {
      success: true,
      poNo,
      liffId,
      liffBaseUrl,
      oaId: process.env.LINE_OA_ID || settings.LINE_OA_ID || '',
      pdfUrl,
      flex,
      messages: [flex],
      shareText
    });
  } catch (err) {
    console.error('LINE share PO error:', err);
    return json(500, { success: false, message: err.message });
  }
};

async function generatePOPdf(poNo) {
  try {
    const res = await generatePdfFunction.handler({
      httpMethod: 'GET',
      queryStringParameters: { poNo }
    }, {});
    const body = JSON.parse(res.body || '{}');
    if (res.statusCode >= 200 && res.statusCode < 300 && body.success !== false) {
      return { success: true, pdfUrl: body.pdfUrl || '' };
    }
    return { success: false, pdfUrl: '' };
  } catch (err) {
    console.warn('Generate PO PDF for LIFF share failed:', err.message);
    return { success: false, pdfUrl: '' };
  }
}

function formatMoney(value) {
  return (parseFloat(value) || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatQty(value) {
  const num = parseFloat(value) || 0;
  return num.toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

function formatDateOnlyTH(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function truncateText(value, maxLength = 30) {
  const text = String(value || '-');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
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

function buildActionUri(liffBaseUrl, action, poNo, appUrl) {
  if (liffBaseUrl) {
    return `${liffBaseUrl}?mode=${encodeURIComponent(action)}&poNo=${encodeURIComponent(poNo)}`;
  }
  return `${appUrl}/liff/share-po.html?mode=${encodeURIComponent(action)}&poNo=${encodeURIComponent(poNo)}`;
}

function buildSharePOFlex(po, items, options) {
  const safeItems = items || [];
  const subtotal = safeItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const vatType = po.vat_type || 'none';
  const vat = vatType === 'exclusive' ? subtotal * 0.07 : (vatType === 'inclusive' ? subtotal - (subtotal / 1.07) : 0);
  const grandTotal = vatType === 'exclusive' ? subtotal + vat : subtotal;
  const itemPreview = safeItems.slice(0, 4).map(item => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'xs',
    contents: [
      { type: 'text', text: '•', size: 'xs', color: '#111827', flex: 0 },
      { type: 'text', text: truncateText(item.part_name, 30), size: 'xs', color: '#111827', wrap: true, flex: 6 },
      { type: 'text', text: `${formatQty(item.qty)} ${item.unit || ''}`.trim(), size: 'xs', color: '#374151', align: 'end', flex: 2 }
    ]
  }));
  if (safeItems.length > 4) {
    itemPreview.push({ type: 'text', text: `และอีก ${safeItems.length - 4} รายการ`, size: 'xxs', color: '#6B7280', margin: 'xs' });
  }

  const approveUri = buildActionUri(options.liffBaseUrl, 'approve', po.po_no, options.appUrl);
  const rejectUri = buildActionUri(options.liffBaseUrl, 'reject', po.po_no, options.appUrl);
  const footerButtons = [
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
          action: { type: 'uri', label: '✅ อนุมัติ', uri: approveUri }
        },
        {
          type: 'button',
          style: 'primary',
          color: '#EF4444',
          height: 'sm',
          action: { type: 'uri', label: '❌ ปฏิเสธ', uri: rejectUri }
        }
      ]
    }
  ];
  if (options.pdfUrl) {
    footerButtons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: { type: 'uri', label: '📄 ดูใบสั่งซื้อ PDF', uri: options.pdfUrl }
    });
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
        contents: [{
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
        }]
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
        contents: footerButtons
      }
    }
  };
}

function buildShareText(po, items, pdfUrl) {
  const total = (items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const lines = [
    `📋 ขออนุมัติ PO: ${po.po_no}`,
    `🏪 ร้านค้า: ${po.shop_name || '-'}`,
    `🚌 ทะเบียน: ${po.plate || '-'}`,
    `💰 ยอดรวม: ${formatMoney(total)} บาท`,
    `📦 จำนวน: ${(items || []).length} รายการ`,
    `✅ อนุมัติ: อนุมัติ PO ${po.po_no}`,
    `❌ ปฏิเสธ: ปฏิเสธ PO ${po.po_no}`
  ];
  if (pdfUrl) lines.push(`📄 PDF: ${pdfUrl}`);
  return lines.join('\n');
}
