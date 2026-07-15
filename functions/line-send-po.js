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
      throw new Error(`LINE API failed: ${lineRes.status} - ${lineErrText}`);
    }

    // 5. Update sent timestamp in DB
    const nowStr = new Date().toISOString();
    await supabase.from('purchase_orders').update({ line_sent_at: nowStr }).eq('po_no', poNo);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sentAt: nowStr })
    };

  } catch (err) {
    console.error('Send PO to LINE Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

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
