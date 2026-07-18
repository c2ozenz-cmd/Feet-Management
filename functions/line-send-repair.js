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

  const repairNo = event.queryStringParameters?.repairNo;
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
      await logLine('line_push_repair_config_missing', {
        method: 'Push',
        msgType: 'Repair',
        recipient: groupId || 'LINE_GROUP_ID_SERVICE',
        preview: `Repair ${repairNo}`,
        costStatus: 'คิดเงิน',
        code: 500,
        success: false
      });
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
      await logLine('line_push_repair_failed', {
        method: 'Push',
        msgType: 'Repair',
        recipient: groupId,
        preview: `Repair ${repair.repair_no} | ${repair.plate || ''}`,
        costStatus: 'คิดเงิน',
        code: lineRes.status,
        success: false,
        error: lineErrText
      });
      throw new Error(`LINE API failed: ${lineRes.status} - ${lineErrText}`);
    }

    // 5. Update sent timestamp in settings/logs (since repairs table does not track lineSentAt directly)
    const nowStr = new Date().toISOString();
    await supabase.from('settings').upsert({ key: `linesent_repair:${repairNo}`, value: nowStr });
    await logLine('line_push_repair_success', {
      method: 'Push',
      msgType: 'Repair',
      recipient: groupId,
      preview: `Repair ${repair.repair_no} | ${repair.plate || ''}`,
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
    console.error('Send Repair to LINE Error:', err);
    await logLine('line_push_repair_error', {
      method: 'Push',
      msgType: 'Repair',
      recipient: 'LINE_GROUP_ID_SERVICE',
      preview: `Repair ${repairNo}`,
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

function formatNumber(value) {
  return (parseFloat(value) || 0).toLocaleString('th-TH');
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

function buildRepairFlexMessage(repair) {
  const plate = repair.plate || '-';

  return {
    type: 'flex',
    altText: `แจ้งซ่อมใหม่ ${repair.repair_no} | ${plate}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'horizontal',
        paddingAll: '16px',
        spacing: 'sm',
        backgroundColor: '#F0B032',
        contents: [
          { type: 'text', text: '🔧', size: 'xxl', flex: 0 },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            contents: [
              { type: 'text', text: 'แจ้งซ่อมใหม่', weight: 'bold', size: 'lg', color: '#FFFFFF' },
              { type: 'text', text: repair.repair_no, size: 'sm', color: '#FFF8E8', margin: 'xs' }
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
            layout: 'vertical',
            backgroundColor: '#F0F4FF',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '🚌 ทะเบียนรถ', size: 'xxs', color: '#6B7280' },
              { type: 'text', text: plate, size: 'xl', color: '#1F416A', weight: 'bold', margin: 'xs' }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              detailRow('🗓️', 'วันที่แจ้ง', formatDateOnlyTH(repair.date || repair.created_at)),
              detailRow('⛽', 'เลขไมล์', repair.mileage ? `${formatNumber(repair.mileage)} กม.` : '-'),
              detailRow('👤', 'ผู้แจ้ง', repair.created_by || '-')
            ]
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '📋 รายการซ่อม', size: 'sm', color: '#6B7280', weight: 'bold' },
              { type: 'text', text: repair.repair_list || '-', size: 'sm', color: '#111827', wrap: true }
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
            color: '#10B981',
            height: 'sm',
            action: { type: 'postback', label: '✅ อนุมัติ', data: `action=approve&type=repair&id=${repair.repair_no}`, displayText: `✅ อนุมัติการซ่อม ${repair.repair_no}` }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#EF4444',
            height: 'sm',
            action: { type: 'postback', label: '❌ ปฏิเสธ', data: `action=reject&type=repair&id=${repair.repair_no}`, displayText: `❌ ปฏิเสธการซ่อม ${repair.repair_no}` }
          }
        ]
      }
    }
  };
}
