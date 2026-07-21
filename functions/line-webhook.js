const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const generatePdfFunction = require('./generate-pdf');

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
  const canApprove = await isLineUserAllowed(lineUserId, 'admin');
  if (!canApprove) {
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
      await logLineWorkflow('repair_update_status_result', { id, success: res.success, message: res.message || '' });
      if (res.success) {
        await saveApprovalInfo('repair', id, lineUserId, approverName);
        const plate = repair?.plate || '';
        const flexMsg = buildApprovalResultFlex('repair', id, approverName, dateStr, plate);
        const replyRes = await replyLineFlex(replyToken, flexMsg);
        await logLineWorkflow('repair_reply_result', {
          id,
          success: replyRes && replyRes.success,
          code: replyRes && replyRes.code,
          body: replyRes && replyRes.body,
          message: replyRes && replyRes.message
        });
        if (!replyRes || !replyRes.success) {
          const groupId = await getLineGroupId('service');
          if (groupId) {
            const pushRes = await pushLineFlex(groupId, flexMsg);
            await logLineWorkflow('repair_push_fallback_result', {
              id,
              groupId,
              success: pushRes && pushRes.success,
              code: pushRes && pushRes.code,
              body: pushRes && pushRes.body,
              message: pushRes && pushRes.message
            });
          }
        }
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
      await logLineWorkflow('po_update_status_result', { id, success: res.success, message: res.message || '' });
      if (res.success) {
        await saveApprovalInfo('po', id, lineUserId, approverName);
        const plate = po?.plate || '';

        // Generate manager-signed PDF before replying to LINE.
        const pdfRes = await generatePOPdf(id);
        const pdfUrl = pdfRes.pdfUrl || '';

        const flexMsg = buildPOApprovalFlex(id, approverName, dateStr, plate, pdfUrl);
        const replyRes = await replyLineFlex(replyToken, flexMsg);
        await logLineWorkflow('po_reply_result', {
          id,
          success: replyRes && replyRes.success,
          code: replyRes && replyRes.code,
          body: replyRes && replyRes.body,
          message: replyRes && replyRes.message
        });
        if (!replyRes || !replyRes.success) {
          const groupId = await getLineGroupId('po');
          if (groupId) {
            const pushRes = await pushLineFlex(groupId, flexMsg);
            await logLineWorkflow('po_push_fallback_result', {
              id,
              groupId,
              success: pushRes && pushRes.success,
              code: pushRes && pushRes.code,
              body: pushRes && pushRes.body,
              message: pushRes && pushRes.message
            });
          } else {
            await logLineWorkflow('po_push_fallback_missing_group', { id });
          }
        }
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

  const poDecisionNoMatch = cleanText.match(/(PO\d+)/i);
  const hasApproveWord = /approve/i.test(cleanText) || cleanText.includes('\u0E2D\u0E19\u0E38\u0E21\u0E31\u0E15\u0E34');
  const hasRejectWord = /reject/i.test(cleanText) || cleanText.includes('\u0E1B\u0E0F\u0E34\u0E40\u0E2A\u0E18');
  if (poDecisionNoMatch && (hasApproveWord || hasRejectWord)) {
    const poNo = poDecisionNoMatch[1].toUpperCase();
    const action = hasRejectWord ? 'reject' : 'approve';
    await handlePOTextDecision(event.replyToken, lineUserId, poNo, action);
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
        const pdfRes = await generatePOPdf(poNo);
        const { data: freshPo } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
        const { data: items } = await supabase.from('po_items').select('*').eq('po_no', poNo);
        await replyLineFlex(event.replyToken, buildPOFlexMessage({ ...(freshPo || po), pdf_url: pdfRes.pdfUrl || (freshPo || po).pdf_url || '' }, items || []));
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

  const statusPoMatch = cleanText.match(/ส่งสถานะ\s*(?:PO\s*)?(PO\d+)/i);
  if (statusPoMatch) {
    const poNo = statusPoMatch[1].toUpperCase();
    const { data: po } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
    if (!po) {
      await replyLineMessage(event.replyToken, `❌ ไม่พบข้อมูลใบสั่งซื้อ ${poNo} ในระบบ`);
      return;
    }
    if (po.status !== 'อนุมัติแล้ว') {
      await replyLineMessage(event.replyToken, `ℹ️ ${poNo} ยังไม่ได้รับการอนุมัติ\nสถานะปัจจุบัน: "${po.status}"`);
      return;
    }
    const approverName = po.approved_by || '—';
    const approvedAt = po.approved_at ? formatDateTH(new Date(po.approved_at)) : formatDateTH(new Date());
    await replyLineFlex(event.replyToken, buildPOApprovalFlex(poNo, approverName, approvedAt, po.plate || '', po.pdf_url || ''));
    return;
  }
}

// ── DATABASE HELPERS (SUPABASE INTEGRATION) ──

async function getNameByLineId(lineUserId) {
  const { data, error } = await supabase.from('profiles').select('name').eq('line_user_id', lineUserId).single();
  return data || null;
}

async function getLineGroupId(type) {
  const keys = type === 'po'
    ? ['LINE_GROUP_ID_PO', 'LINE_GROUP_ID']
    : type === 'service'
      ? ['LINE_GROUP_ID_SERVICE', 'LINE_GROUP_ID']
      : ['LINE_GROUP_ID'];
  const { data } = await supabase.from('settings').select('key,value').in('key', keys);
  const map = new Map((data || []).map(row => [row.key, row.value]));
  return keys.map(key => map.get(key)).find(Boolean) || '';
}

async function handlePOTextDecision(replyToken, lineUserId, poNo, action) {
  const canApprove = await isLineUserAllowed(lineUserId, 'admin');
  if (!canApprove) {
    await logLineWorkflow('po_text_decision_permission_denied', { poNo, action, lineUserId });
    await replyLineMessage(replyToken, '⛔ คุณไม่มีสิทธิ์อนุมัติรายการนี้\nกรุณาติดต่อผู้ดูแลระบบ');
    return;
  }

  const approver = await getNameByLineId(lineUserId);
  const approverName = approver ? approver.name : 'ไม่ทราบชื่อ';
  const { data: po } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
  if (!po) {
    await replyLineMessage(replyToken, `❌ ไม่พบข้อมูลใบสั่งซื้อ ${poNo} ในระบบ`);
    return;
  }

  const currentStatus = po.status || '';
  if (!['รออนุมัติ', 'ออกPO'].includes(currentStatus)) {
    await replyLineMessage(replyToken, `ℹ️ ${poNo} ดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${currentStatus}"`);
    return;
  }

  if (action === 'reject') {
    const res = await updatePOStatus(poNo, 'ปฏิเสธ');
    await logLineWorkflow('po_text_reject_result', { id: poNo, success: res.success, message: res.message || '' });
    await replyLineMessage(replyToken, res.success
      ? `❌ ปฏิเสธใบสั่งซื้อ ${poNo}\nโดย: ${approverName}`
      : `❌ เกิดข้อผิดพลาด: ${res.message}`);
    return;
  }

  const res = await updatePOStatus(poNo, 'อนุมัติแล้ว');
  await logLineWorkflow('po_text_approve_result', { id: poNo, success: res.success, message: res.message || '' });
  if (!res.success) {
    await replyLineMessage(replyToken, `❌ เกิดข้อผิดพลาด: ${res.message}`);
    return;
  }

  await saveApprovalInfo('po', poNo, lineUserId, approverName);
  const pdfRes = await generatePOPdf(poNo);
  const dateStr = formatDateTH(new Date());
  const flexMsg = buildPOApprovalFlex(poNo, approverName, dateStr, po.plate || '', pdfRes.pdfUrl || po.pdf_url || '');
  await replyLineFlex(replyToken, flexMsg);
}

async function isLineUserAllowed(lineUserId, requiredRole) {
  const { data, error } = await supabase.from('profiles').select('role').eq('line_user_id', lineUserId).single();
  if (error || !data) return false;
  if (requiredRole === 'admin') return ['admin', 'manager'].includes(data.role);
  return true;
}

async function updateRepairStatus(repairNo, status) {
  const { error } = await supabase.from('repairs').update({ status }).eq('repair_no', repairNo);
  if (error) return { success: false, message: error.message };
  if (isRepairDoneStatus(status)) {
    try {
      await deductStockForRepair(repairNo);
    } catch (deductErr) {
      await logLineWorkflow('repair_stock_deduct_error', { id: repairNo, message: deductErr.message });
      return { success: false, message: `อัปเดตสถานะแล้ว แต่ตัดอะไหล่ไม่สำเร็จ: ${deductErr.message}` };
    }
  }
  return { success: true, message: '' };
}

async function updatePOStatus(poNo, status) {
  const { error } = await supabase.from('purchase_orders').update({ status }).eq('po_no', poNo);
  return { success: !error, message: error ? error.message : '' };
}

function isRepairDoneStatus(status) {
  const value = String(status || '');
  return value === 'เสร็จแล้ว' || value.includes('เสร็จ') || value.includes('เธชเธฃเนเธ') || value.includes('เน€เธชเธฃ');
}

async function deductStockForRepair(repairNo) {
  const { data: priorLogs, error: priorErr } = await supabase
    .from('stock_logs')
    .select('part_name, qty')
    .eq('type', 'OUT')
    .eq('ref', `Repair: ${repairNo}`);
  if (priorErr) throw priorErr;

  const { data: parts, error: partsErr } = await supabase
    .from('repair_parts')
    .select('*')
    .eq('repair_no', repairNo);
  if (partsErr) throw partsErr;

  const deductedByPart = new Map();
  (priorLogs || []).forEach(log => {
    const partName = String(log.part_name || '').trim();
    if (!partName) return;
    deductedByPart.set(partName, (deductedByPart.get(partName) || 0) + (parseFloat(log.qty) || 0));
  });

  for (const part of (parts || [])) {
    const partName = part.part_name;
    const requiredQty = parseFloat(part.qty) || 0;
    const alreadyDeducted = deductedByPart.get(String(partName || '').trim()) || 0;
    const deductQty = Math.max(0, requiredQty - alreadyDeducted);
    if (!partName || deductQty <= 0) continue;

    const { data: stockRows, error: stockErr } = await supabase
      .from('stock')
      .select('*')
      .eq('part_name', partName)
      .limit(1);
    if (stockErr) throw stockErr;
    const stock = (stockRows || [])[0];
    if (!stock) continue;

    const currentQty = parseFloat(stock.qty) || 0;
    const { error: updateErr } = await supabase
      .from('stock')
      .update({ qty: Math.max(0, currentQty - deductQty) })
      .eq('id', stock.id);
    if (updateErr) throw updateErr;

    const { error: logErr } = await supabase.from('stock_logs').insert({
      type: 'OUT',
      part_name: partName,
      qty: deductQty,
      ref: `Repair: ${repairNo}`,
      log_id: `LOG${Date.now()}${Math.floor(Math.random() * 1000)}`
    });
    if (logErr) throw logErr;
  }
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

async function generatePOPdf(poNo) {
  try {
    const res = await generatePdfFunction.handler({
      httpMethod: 'GET',
      queryStringParameters: { poNo }
    }, {});
    const json = JSON.parse(res.body || '{}');
    const success = res.statusCode >= 200 && res.statusCode < 300 && json.success !== false;
    await logLineWorkflow('po_pdf_result', {
      id: poNo,
      success,
      code: res.statusCode,
      pdfUrl: json.pdfUrl || '',
      error: json.error || json.message || ''
    });
    return { success, pdfUrl: json.pdfUrl || '' };
  } catch (err) {
    console.error('PDF Generation failed:', err);
    await logLineWorkflow('po_pdf_error', { id: poNo, message: err.message, stack: err.stack });
    return { success: false, pdfUrl: '' };
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
    if (!error) {
      try {
        await deductStockForRepair(refNo);
      } catch (deductErr) {
        await logLineWorkflow('repair_stock_deduct_error', { id: refNo, message: deductErr.message });
        await replyLineFlex(replyToken, buildTechReportFlex(refNo, techName, text, false, true, true));
        return;
      }
    }
    
    await replyLineFlex(replyToken, buildTechReportFlex(refNo, techName, text, !error, !error, true));
  } else {
    await replyLineFlex(replyToken, buildTechReportFlex(refNo, techName, text, false, false, false));
  }
}

// ── LINE HTTP CLIENT (FETCH API) ──

async function replyLineMessage(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  return callLineAPI(url, {
    replyToken,
    messages: [{ type: 'text', text }]
  });
}

async function replyLineFlex(replyToken, flexMsg) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  return callLineAPI(url, {
    replyToken,
    messages: [flexMsg]
  });
}

async function pushLineFlex(to, flexMsg) {
  const url = 'https://api.line.me/v2/bot/message/push';
  return callLineAPI(url, {
    to,
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
    const body = await res.text();
    await logLineMessage(url, payload, res.status, body);
    if (!res.ok) {
      await logLineWorkflow('line_api_failed', {
        url,
        code: res.status,
        body,
        messageType: payload && payload.messages && payload.messages[0] && payload.messages[0].type,
        preview: payload && payload.messages && payload.messages[0] && (payload.messages[0].altText || payload.messages[0].text || '')
      });
    }
    return { success: res.ok, code: res.status, body };
  } catch (e) {
    await logLineMessage(url, payload, `ERROR: ${e.message}`, '');
    await logLineWorkflow('line_api_exception', { url, message: e.message, stack: e.stack });
    return { success: false, message: e.message };
  }
}

async function logLineMessage(url, payload, responseCode, responseBody) {
  try {
    const isPush = url.includes('/push');
    const firstMsg = payload?.messages?.[0] || {};
    const detail = {
      method: isPush ? 'Push' : 'Reply',
      msgType: firstMsg.type || 'unknown',
      recipient: isPush ? (payload.to || '') : `Reply Token: ${payload.replyToken ? `${String(payload.replyToken).slice(0, 10)}...` : ''}`,
      preview: firstMsg.text || firstMsg.altText || '',
      costStatus: isPush ? 'คิดเงิน (Push)' : 'ฟรี (Reply)',
      code: responseCode,
      body: responseBody || '',
      success: Number(responseCode) >= 200 && Number(responseCode) < 300
    };
    await supabase.from('line_logs').insert({
      stage: isPush ? 'line_push' : 'line_reply',
      detail: JSON.stringify(detail)
    });
  } catch (err) {
    console.error('logLineMessage error:', err);
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

// Flex Message Builders
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
              detailRow('⛽', 'เลขไมล์', repair.mileage ? `${formatMoney(repair.mileage).replace('.00', '')} กม.` : '-'),
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

function buildApprovalResultFlex(type, id, approverName, dateStr, plate) {
  if (type === 'repair') {
    const title = 'อนุมัติการซ่อมแล้ว';
    return {
      type: 'flex',
      altText: `✅ ${title} | ${id} | 🚌 ${plate || ''}`,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#10B981',
          paddingAll: '16px',
          contents: [{
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '✅', size: 'xxl', flex: 0 },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'sm',
                contents: [
                  { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#FFFFFF' },
                  { type: 'text', text: id, size: 'sm', color: '#D1FAE5' }
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
              backgroundColor: '#1E3A5F',
              cornerRadius: '8px',
              paddingAll: '10px',
              contents: [
                { type: 'text', text: '🚌', size: 'sm', flex: 0 },
                { type: 'text', text: plate || '—', size: 'lg', weight: 'bold', color: '#FFFFFF', margin: 'sm' }
              ]
            },
            detailRow('👤 ผู้อนุมัติ', '', approverName || '—'),
            detailRow('📅 เวลา', '', dateStr || '—'),
            { type: 'separator', color: '#E5E7EB' },
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#F0FDF4',
              cornerRadius: '8px',
              paddingAll: '12px',
              contents: [
                { type: 'text', text: '🔧 ช่าง — กรุณาแจ้งสถานะงาน', size: 'sm', color: '#065F46', weight: 'bold' },
                { type: 'text', text: 'กดปุ่มด้านล่าง หรือพิมพ์รายงานละเอียดเอง', size: 'xs', color: '#6B7280', wrap: true, margin: 'sm' }
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
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: { type: 'postback', label: '📝 พิมพ์รายงานเอง', data: `action=tech_report&type=${type}&id=${id}`, displayText: `รายงานการซ่อม ${id}: ` }
            }
          ]
        }
      }
    };
  }

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
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#10B981',
      paddingAll: '16px',
      contents: [{
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: '✅', size: 'xxl', flex: 0 },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            contents: [
              { type: 'text', text: 'อนุมัติใบสั่งซื้อแล้ว', weight: 'bold', size: 'lg', color: '#FFFFFF' },
              { type: 'text', text: poNo, size: 'sm', color: '#D1FAE5' }
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
          backgroundColor: '#1E3A5F',
          cornerRadius: '8px',
          paddingAll: '10px',
          contents: [
            { type: 'text', text: '🚌', size: 'sm', flex: 0 },
            { type: 'text', text: plate || 'Stock', size: 'lg', weight: 'bold', color: '#FFFFFF', margin: 'sm' }
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
            detailRow('👤 ผู้อนุมัติ', '', approverName || '—'),
            detailRow('📅 วันที่', '', dateStr || '—')
          ]
        },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: pdfUrl ? '#E8F5E9' : '#ECFDF5',
          cornerRadius: '8px',
          paddingAll: '12px',
          spacing: 'xs',
          contents: [
            { type: 'text', text: pdfUrl ? '💡 สร้าง PDF ใบสั่งซื้อพร้อมลายเซ็นเรียบร้อยแล้ว' : '💡 ระบบกำลังสร้าง PDF ใบสั่งซื้ออัตโนมัติ', size: 'xs', color: pdfUrl ? '#2E7D32' : '#059669', wrap: true }
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
    altText: `✅ อนุมัติ PO ${poNo} | 🚌 ${plate || ''} เรียบร้อย`,
    contents
  };
}

function buildTechReportFlex(refId, techName, report, saved, statusUpdated, isDone) {
  const statusText = statusUpdated
    ? (isDone ? '✅ อัปเดตสถานะเป็น "เสร็จแล้ว"' : '📦 อัปเดตสถานะเป็น "รออะไหล่"')
    : null;

  return {
    type: 'flex',
    altText: saved ? `✅ บันทึกรายงาน ${refId}` : `⚠️ ไม่พบ ${refId}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        backgroundColor: saved ? '#10B981' : '#EF4444',
        contents: [{
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: saved ? '✅' : '⚠️', size: 'xl', flex: 0 },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'sm',
              contents: [
                { type: 'text', text: saved ? 'บันทึกรายงานแล้ว' : 'ไม่พบรายการ', color: '#ffffff', size: 'md', weight: 'bold' },
                { type: 'text', text: refId, color: saved ? '#D1FAE5' : '#FEE2E2', size: 'sm' }
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
        contents: saved ? [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F0FDF4',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: `👷 ${techName}`, size: 'sm', weight: 'bold', color: '#065F46' },
              { type: 'text', text: report, size: 'sm', color: '#111827', wrap: true, margin: 'sm' }
            ]
          },
          detailRow('📋 งาน', '', refId),
          detailRow('📅 เวลา', '', formatDateTH(new Date())),
          ...(statusText ? [{
            type: 'box',
            layout: 'horizontal',
            backgroundColor: isDone ? '#D1FAE5' : '#EDE9FE',
            cornerRadius: '6px',
            paddingAll: '8px',
            margin: 'sm',
            contents: [
              { type: 'text', text: statusText, size: 'xs', color: isDone ? '#065F46' : '#5B21B6', wrap: true }
            ]
          }] : [])
        ] : [
          { type: 'text', text: `ไม่พบ ${refId} ในระบบ`, size: 'sm', color: '#EF4444', wrap: true }
        ]
      }
    }
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
