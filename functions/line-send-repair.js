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

  const repairNo = event.queryStringParameters.repairNo;
  if (!repairNo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing repairNo parameter' }) };
  }

  try {
    // 1. Fetch Repair details
    const { data: repair, error: repErr } = await supabase.from('repairs').select('*').eq('repair_no', repairNo).single();
    if (repErr || !repair) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Repair request not found: ' + (repErr?.message || '') }) };
    }

    // 2. Get LINE Group ID from settings
    const { data: groupSetting } = await supabase.from('settings').select('value').eq('key', 'LINE_GROUP_ID_SERVICE').single();
    const groupId = groupSetting?.value || '';

    if (!LINE_CHANNEL_ACCESS_TOKEN || !groupId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'LINE Token or Group ID Service not configured' }) };
    }

    // 3. Build Repair Flex Message
    const flexMsg = buildRepairFlexMessage(repair);

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

    // 5. Update sent timestamp in settings/logs (since repairs table does not track lineSentAt directly)
    const nowStr = new Date().toISOString();
    await supabase.from('settings').upsert({ key: `linesent_repair:${repairNo}`, value: nowStr });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sentAt: nowStr })
    };

  } catch (err) {
    console.error('Send Repair to LINE Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function buildRepairFlexMessage(repair) {
  const statusColor = {
    'รอดำเนินการ': '#E8A838',
    'กำลังซ่อม'  : '#3B82F6',
    'รออะไหล่'   : '#8B5CF6',
    'เสร็จแล้ว'  : '#10B981'
  };
  const headerColor = statusColor[repair.status] || '#D97757';

  return {
    type: 'flex',
    altText: `🔧 แจ้งซ่อมใหม่ | ${repair.repair_no} | ทะเบียน ${repair.plate}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        backgroundColor: headerColor,
        contents: [
          { type: 'text', text: '🔧 ขออนุมัติแจ้งซ่อมใหม่', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: `เลขที่: ${repair.repair_no}`, size: 'xs', color: '#f3f4f6', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `ทะเบียนรถ: ${repair.plate}`, size: 'sm', weight: 'bold' },
              { type: 'text', text: `รายการแจ้งซ่อม:\n${repair.repair_list || '-'}`, size: 'sm', wrap: true }
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
            color: '#1a3a5c',
            action: { type: 'postback', label: 'อนุมัติซ่อม', data: `action=approve&type=repair&id=${repair.repair_no}` }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: 'ปฏิเสธ', data: `action=reject&type=repair&id=${repair.repair_no}` }
          }
        ]
      }
    }
  };
}
