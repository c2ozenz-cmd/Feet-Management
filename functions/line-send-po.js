const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

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

  const poNo = event.queryStringParameters.poNo;
  if (!poNo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing poNo parameter' }) };
  }

  try {
    // 1. Fetch PO and items
    const { data: po, error: poErr } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
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

    // 3. Build PO Flex Message
    const flexMsg = buildPOFlexMessage(po, items || []);

    // 4. Send Push to LINE group
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

    // 5. Update sent timestamp in DB
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

function buildPOFlexMessage(po, items) {
  return {
    type: 'flex',
    altText: `ขออนุมัติสั่งซื้ออะไหล่ PO: ${po.po_no}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📝 ขออนุมัติสั่งซื้ออะไหล่ (PO)', weight: 'bold', size: 'lg', color: '#1a3a5c' },
          { type: 'text', text: `เลขที่ PO: ${po.po_no}`, size: 'xs', color: '#aaaaaa', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `ร้านค้า: ${po.shop_name}`, size: 'sm' },
              { type: 'text', text: `สำหรับรถทะเบียน: ${po.plate || '-'}`, size: 'sm' },
              { type: 'text', text: `อ้างอิงใบแจ้งซ่อม: ${po.ref_repair_no || '-'}`, size: 'sm' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#15803d',
            action: { type: 'postback', label: '✅ อนุมัติ', data: `action=approve&type=po&id=${po.po_no}` }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '❌ ปฏิเสธ', data: `action=reject&type=po&id=${po.po_no}` }
          }
        ]
      }
    }
  };
}
