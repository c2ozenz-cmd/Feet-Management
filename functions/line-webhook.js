const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
let supabase;
function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Main Netlify handler
exports.handler = async (event, context) => {
  initSupabase();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const events = body.events || [];

    for (const ev of events) {
      if (ev.type === 'postback') {
        await handlePostback(ev);
      } else if (ev.type === 'message' && ev.message.type === 'text') {
        await handleTextMessage(ev);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok' })
    };
  } catch (err) {
    console.error('Error handling LINE webhook:', err);
    await logLineWorkflow('doPost_error', { message: err.message, stack: err.stack });
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', error: err.message })
    };
  }
};

// Handle Postback Actions (Approve, Reject, Technician Actions)
async function handlePostback(event) {
  const data = event.postback.data;
  const replyToken = event.replyToken;
  const lineUserId = event.source.userId;
  const params = parseQueryString(data);

  const action = params.action;
  const type = params.type;
  const id = params.id;

  await logLineWorkflow('postback_received', { action, type, id, lineUserId, data });

  // 1. Technician Action (tech_done, tech_waiting, tech_report)
  if (['tech_done', 'tech_waiting', 'tech_report'].includes(action)) {
    const user = await getNameByLineId(lineUserId);
    const techName = user ? user.name : 'ช่าง';

    if (action === 'tech_done') {
      const res = await updateRepairStatus(id, 'เสร็จแล้ว');
      await replyLineMessage(replyToken, res.success ? `✅ ${id} อัปเดตสถานะเป็น "เสร็จแล้ว" แล้ว\nโดย: ${techName}` : `❌ ${res.message}`);
    } else if (action === 'tech_waiting') {
      const res = await updateRepairStatus(id, 'รออะไหล่');
      await replyLineMessage(replyToken, res.success ? `📦 ${id} อัปเดตสถานะเป็น "รออะไหล่" แล้ว\nโดย: ${techName}` : `❌ ${res.message}`);
    } else if (action === 'tech_report') {
      // check status in DB
      const { data: rep } = await supabase.from('repairs').select('status').eq('repair_no', id).single();
      if (rep && rep.status === 'เสร็จแล้ว') {
        await replyLineMessage(replyToken, `⚠️ ${id} รายงานแล้ว\nหากต้องการแก้ไขรายงาน กรุณาแจ้งแอดมิน`);
        return;
      }
      // set pending report state
      await setPendingReport(lineUserId, id);
      await replyLineMessage(replyToken, `✏️ ${techName} พิมพ์รายละเอียดงานได้เลยครับ`);
    }
    return;
  }

  // 2. Check Admin Permission for approval actions
  const isAdmin = await isLineUserAllowed(lineUserId, 'admin');
  if (!isAdmin) {
    await logLineWorkflow('approval_permission_denied', { action, type, id, lineUserId });
    await replyLineMessage(replyToken, '⛔ คุณไม่มีสิทธิ์อนุมัติรายการนี้\nกรุณาติดต่อผู้ดูแลระบบ');
    return;
  }

  const approver = await getNameByLineId(lineUserId);
  const approverName = approver ? approver.name : 'ไม่ทราบชื่อ';
  const dateStr = formatDateTH(new Date());

  // ── Repair Approval ──
  if (type === 'repair') {
    const { data: repair } = await supabase.from('repairs').select('*').eq('repair_no', id).single();
    const curStatus = repair?.status || '';

    if (curStatus !== 'รอดำเนินการ') {
      await logLineWorkflow('repair_invalid_status', { id, curStatus, lineUserId });
      const alreadyDone = ['กำลังซ่อม', 'รออะไหล่', 'เสร็จแล้ว'].includes(curStatus);
      await replyLineMessage(replyToken, alreadyDone ? `ℹ️ ${id} ได้รับการอนุมัติและดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${curStatus}"` : `⚠️ ไม่สามารถดำเนินการได้\n${id} สถานะปัจจุบัน: "${curStatus}"`);
      return;
    }

    if (action === 'approve') {
      const res = await updateRepairStatus(id, 'กำลังซ่อม');
      if (res.success) {
        await saveApprovalInfo('repair', id, lineUserId, approverName);
        const plate = repair?.plate || '';
        const flexMsg = buildApprovalResultFlex('repair', id, approverName, dateStr, plate);
        await replyLineFlex(replyToken, flexMsg);
      } else {
        await replyLineMessage(replyToken, `❌ เกิดข้อผิดพลาด: ${res.message}`);
      }
    } else {
      await replyLineMessage(replyToken, `❌ ปฏิเสธการซ่อม ${id}\nโดย: ${approverName}`);
    }
  } 

  // ── PO Approval ──
  else if (type === 'po') {
    const { data: po } = await supabase.from('purchase_orders').select('*').eq('po_no', id).single();
    const curStatus = po?.status || '';

    if (curStatus !== 'รออนุมัติ' && curStatus !== 'ออกPO') {
      await logLineWorkflow('po_invalid_status', { id, curStatus, lineUserId });
      await replyLineMessage(replyToken, `⚠️ ไม่สามารถดำเนินการได้\n${id} สถานะปัจจุบัน: "${curStatus}" แล้ว`);
      return;
    }

    if (action === 'approve') {
      // update status to approved
      const res = await updatePOStatus(id, 'อนุมัติแล้ว');
      if (res.success) {
        await saveApprovalInfo('po', id, lineUserId, approverName);
        const plate = po?.plate || '';

        // Call serverless PDF generator endpoint
        let pdfUrl = '';
        try {
          const pdfRes = await fetch(`${process.env.URL}/.netlify/functions/generate-pdf?poNo=${id}`);
          if (pdfRes.ok) {
            const pdfJson = await pdfRes.json();
            pdfUrl = pdfJson.pdfUrl || '';
          }
        } catch (pdfErr) {
          console.error('PDF Generation failed via API:', pdfErr);
        }

        const flexMsg = buildPOApprovalFlex(id, approverName, dateStr, plate, pdfUrl);
        await replyLineFlex(replyToken, flexMsg);
      } else {
        await replyLineMessage(replyToken, `❌ เกิดข้อผิดพลาด: ${res.message}`);
      }
    } else {
      await replyLineMessage(replyToken, `❌ ปฏิเสธใบสั่งซื้อ ${id}\nโดย: ${approverName}`);
    }
  }
}

// Handle Direct Text Commands
async function handleTextMessage(event) {
  const lineUserId = event.source.userId;
  const text = event.message.text.trim();

  // check pending report input state
  const pendingId = await getPendingReport(lineUserId);
  if (pendingId) {
    await clearPendingReport(lineUserId);
    await handleTechReport(event.replyToken, lineUserId, pendingId, text);
    return;
  }

  // command pattern matching
  const cleanText = text.replace(/\r/g, '').trim();
  const reportMatch = cleanText.match(/^รายงาน\s+(REP[\w-]+|PO[\w-]+)\s*[:：]\s*([\s\S]+)/i);
  if (reportMatch) {
    const refId = reportMatch[1].toUpperCase();
    const report = reportMatch[2].trim();
    await handleTechReport(event.replyToken, lineUserId, refId, report);
    return;
  }

  // request approval flex via keywords in group
  const poMatch = cleanText.match(/ขออนุมัติ\s*(?:PO\s*)?(PO\d+)/i);
  const repMatch = cleanText.match(/ขออนุมัติ\s*(?:ซ่อม\s*)?(REP\d+)/i);

  if (poMatch) {
    const poNo = poMatch[1].toUpperCase();
    const { data: po } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
    if (po) {
      if (!['รออนุมัติ', 'ออกPO'].includes(po.status)) {
        await replyLineMessage(event.replyToken, `ℹ️ ใบสั่งซื้อ ${poNo} ได้รับการอนุมัติหรือดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${po.status}"`);
      } else {
        const { data: items } = await supabase.from('po_items').select('*').eq('po_no', poNo);
        await replyLineFlex(event.replyToken, buildPOFlexMessage(po, items || []));
      }
    } else {
      await replyLineMessage(event.replyToken, `❌ ไม่พบข้อมูลใบสั่งซื้อ ${poNo} ในระบบ`);
    }
    return;
  }

  if (repMatch) {
    const repairNo = repMatch[1].toUpperCase();
    const { data: repair } = await supabase.from('repairs').select('*').eq('repair_no', repairNo).single();
    if (repair) {
      if (repair.status !== 'รอดำเนินการ') {
        await replyLineMessage(event.replyToken, `ℹ️ รายการแจ้งซ่อม ${repairNo} ได้รับการอนุมัติหรือดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${repair.status}"`);
      } else {
        await replyLineFlex(event.replyToken, buildRepairFlexMessage(repair));
      }
    } else {
      await replyLineMessage(event.replyToken, `❌ ไม่พบข้อมูลใบแจ้งซ่อม ${repairNo} ในระบบ`);
    }
    return;
  }
}

// ── DATABASE HELPERS (SUPABASE INTEGRATION) ──

async function getNameByLineId(lineUserId) {
  const { data, error } = await supabase.from('profiles').select('name').eq('line_user_id', lineUserId).single();
  return data || null;
}

async function isLineUserAllowed(lineUserId, requiredRole) {
  const { data, error } = await supabase.from('profiles').select('role').eq('line_user_id', lineUserId).single();
  if (error || !data) return false;
  if (requiredRole === 'admin') return data.role === 'admin';
  return true;
}

async function updateRepairStatus(repairNo, status) {
  const { error } = await supabase.from('repairs').update({ status }).eq('repair_no', repairNo);
  return { success: !error, message: error ? error.message : '' };
}

async function updatePOStatus(poNo, status) {
  const { error } = await supabase.from('purchase_orders').update({ status }).eq('po_no', poNo);
  return { success: !error, message: error ? error.message : '' };
}

async function saveApprovalInfo(type, id, lineUserId, name) {
  if (type === 'repair') {
    await supabase.from('repairs').update({
      approved_by: name,
      approved_at: new Date().toISOString()
    }).eq('repair_no', id);
  } else if (type === 'po') {
    await supabase.from('purchase_orders').update({
      approved_by: name,
      approved_at: new Date().toISOString()
    }).eq('po_no', id);
  }
}

// Pending report triggers (using Supabase config or temporary key-values in settings/session tables)
// We can store pending states inside a simple supabase table `pending_line_states` or `settings`
async function getPendingReport(lineUserId) {
  const { data } = await supabase.from('settings').select('value').eq('key', `pending_report:${lineUserId}`).single();
  return data ? data.value : null;
}

async function setPendingReport(lineUserId, id) {
  await supabase.from('settings').upsert({ key: `pending_report:${lineUserId}`, value: id });
}

async function clearPendingReport(lineUserId) {
  await supabase.from('settings').delete().eq('key', `pending_report:${lineUserId}`);
}

async function handleTechReport(replyToken, lineUserId, refNo, text) {
  const user = await getNameByLineId(lineUserId);
  const techName = user ? user.name : 'ช่าง';
  
  if (refNo.startsWith('REP')) {
    const { error } = await supabase.from('repairs').update({
      repair_summary: text,
      status: 'เสร็จแล้ว'
    }).eq('repair_no', refNo);
    
    await replyLineMessage(replyToken, !error ? `📝 ${refNo} บันทึกรายงานการซ่อมสำเร็จ\nโดยช่าง: ${techName}` : `❌ ล้มเหลว: ${error.message}`);
  } else {
    await replyLineMessage(replyToken, `⚠️ รูปแบบคำสั่งไม่ถูกต้องหรือประเภทเอกสารไม่ตรง`);
  }
}

// ── LINE HTTP CLIENT (FETCH API) ──

async function replyLineMessage(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  await callLineAPI(url, {
    replyToken,
    messages: [{ type: 'text', text }]
  });
}

async function replyLineFlex(replyToken, flexMsg) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  await callLineAPI(url, {
    replyToken,
    messages: [flexMsg]
  });
}

async function callLineAPI(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
    return { success: res.ok, code: res.status };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ── LOGGING ──
async function logLineWorkflow(stage, detail) {
  try {
    await supabase.from('line_logs').insert({
      stage,
      detail: JSON.stringify(detail)
    });
  } catch (e) {
    console.error('logLineWorkflow error:', e);
  }
}

// Helper Query String Parser
function parseQueryString(queryString) {
  const params = {};
  const queries = queryString.split('&');
  for (let i = 0; i < queries.length; i++) {
    const temp = queries[i].split('=');
    if (temp[0]) {
      params[temp[0]] = decodeURIComponent(temp[1] || '');
    }
  }
  return params;
}

// Flex Message Builders (translated from LINE API formats in Line.gs)
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

function buildRepairFlexMessage(repair) {
  return {
    type: 'flex',
    altText: `ขออนุมัติแจ้งซ่อม: ${repair.repair_no}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🛠️ ขออนุมัติใบแจ้งซ่อม', weight: 'bold', size: 'lg', color: '#1a3a5c' },
          { type: 'text', text: `เลขที่: ${repair.repair_no}`, size: 'xs', color: '#aaaaaa', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `ทะเบียนรถ: ${repair.plate}`, size: 'sm' },
              { type: 'text', text: `รายการซ่อม: ${repair.repair_list || '-'}`, size: 'sm', wrap: true }
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
            action: { type: 'postback', label: '✅ อนุมัติซ่อม', data: `action=approve&type=repair&id=${repair.repair_no}` }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '❌ ปฏิเสธ', data: `action=reject&type=repair&id=${repair.repair_no}` }
          }
        ]
      }
    }
  };
}

function buildApprovalResultFlex(type, id, approverName, dateStr, plate) {
  return {
    type: 'flex',
    altText: `ผลอนุมัติ: ${id}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🟢 อนุมัติซ่อมสำเร็จ', weight: 'bold', size: 'lg', color: '#15803d' },
          { type: 'text', text: `เลขที่แจ้งซ่อม: ${id}`, size: 'xs', color: '#aaaaaa', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `ผู้อนุมัติ: ${approverName}`, size: 'sm' },
              { type: 'text', text: `ทะเบียนรถ: ${plate}`, size: 'sm' },
              { type: 'text', text: `เมื่อ: ${dateStr}`, size: 'sm' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1a3a5c',
            action: { type: 'postback', label: '🔧 เสร็จแล้ว', data: `action=tech_done&id=${id}` }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '📦 รออะไหล่', data: `action=tech_waiting&id=${id}` }
          },
          {
            type: 'button',
            style: 'link',
            action: { type: 'postback', label: '✏️ พิมพ์รายงานช่าง', data: `action=tech_report&id=${id}` }
          }
        ]
      }
    }
  };
}

function buildPOApprovalFlex(poNo, approverName, dateStr, plate, pdfUrl) {
  const contents = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '🟢 อนุมัติสั่งซื้อสำเร็จ', weight: 'bold', size: 'lg', color: '#15803d' },
        { type: 'text', text: `เลขที่ PO: ${poNo}`, size: 'xs', color: '#aaaaaa', margin: 'xs' },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `ผู้อนุมัติ: ${approverName}`, size: 'sm' },
            { type: 'text', text: `รถทะเบียน: ${plate}`, size: 'sm' },
            { type: 'text', text: `เมื่อ: ${dateStr}`, size: 'sm' }
          ]
        }
      ]
    }
  };
  
  if (pdfUrl) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'link',
          color: '#15803d',
          action: { type: 'uri', label: '📄 เปิดไฟล์ใบสั่งซื้อ (PDF)', uri: pdfUrl }
        }
      ]
    };
  }
  
  return {
    type: 'flex',
    altText: `อนุมัติ PO: ${poNo}`,
    contents
  };
}

// Date Formatter Helper
function formatDateTH(date) {
  const d = new Date(date);
  const year = d.getFullYear() + 543;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hour}:${min}`;
}
