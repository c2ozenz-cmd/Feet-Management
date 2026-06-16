// ============================================================
// Line.gs — Line Messaging API Integration
// ============================================================

function getLineToken() { return getSettingValue('LINE_CHANNEL_TOKEN') || ''; }
function getLineGroupId(type) {
  if (type === 'po')      return getSettingValue('LINE_GROUP_ID_PO')     || getSettingValue('LINE_GROUP_ID') || '';
  if (type === 'service') return getSettingValue('LINE_GROUP_ID_SERVICE') || getSettingValue('LINE_GROUP_ID') || '';
  return getSettingValue('LINE_GROUP_ID') || '';
}

// ============================================================
// SESSION — เก็บสถานะรอรายงานของช่าง
// ============================================================

function setPendingReport(lineUserId, refId) {
  PropertiesService.getScriptProperties()
    .setProperty('pending_' + lineUserId, 
      JSON.stringify({ refId, ts: Date.now() })
    );
}

function getPendingReport(lineUserId) {
  const raw = PropertiesService.getScriptProperties()
    .getProperty('pending_' + lineUserId);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    // หมดอายุหลัง 10 นาที
    if (Date.now() - obj.ts > 10 * 60 * 1000) {
      clearPendingReport(lineUserId);
      return null;
    }
    return obj.refId;
  } catch(e) { return null; }
}

function clearPendingReport(lineUserId) {
  PropertiesService.getScriptProperties()
    .deleteProperty('pending_' + lineUserId);
}

// ── Webhook Entry Point ──
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const events = body.events || [];

    events.forEach(event => {
      if (event.type === 'postback') {
        handlePostback(event);

      } else if (event.type === 'message' && event.message.type === 'text') {
        const lineUserId = event.source.userId;
        const text       = event.message.text.trim();

        // ── เช็ค session ก่อนว่ารอรายงานอยู่ไหม ──
        const pendingId = getPendingReport(lineUserId);
        if (pendingId) {
          clearPendingReport(lineUserId);
          handleTechReport(event.replyToken, lineUserId, pendingId, text);
          return;
        }

        // ── รับรายงานแบบพิมพ์เองพร้อม prefix (fallback) ──
        const cleanText   = text.replace(/\r/g, '').trim();
        const reportMatch = cleanText.match(/^รายงาน\s+(REP[\w-]+|PO[\w-]+)\s*[:：]\s*([\s\S]+)/i);
        if (reportMatch) {
          const refId  = reportMatch[1].toUpperCase();
          const report = reportMatch[2].trim();
          handleTechReport(event.replyToken, lineUserId, refId, report);
          return;
        }

        // ── ขออนุมัติผ่านคำสั่งในกลุ่ม (Free Reply Flex Message) ──
        const poMatch = cleanText.match(/ขออนุมัติ\s*(?:PO\s*)?(PO\d+)/i);
        const repMatch = cleanText.match(/ขออนุมัติ\s*(?:ซ่อม\s*)?(REP\d+)/i);

        if (poMatch) {
          const poNo = poMatch[1].toUpperCase();
          const po = getPOs().find(p => p.poNo === poNo);
          if (po) {
            if (!['รออนุมัติ', 'ออกPO'].includes(po.status)) {
              replyLineMessage(event.replyToken, `ℹ️ ใบสั่งซื้อ ${poNo} ได้รับการอนุมัติหรือดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${po.status}"`);
            } else {
              const items = getPOItems(poNo);
              replyLineFlex(event.replyToken, buildPOFlexMessage(po, items));
            }
          } else {
            replyLineMessage(event.replyToken, `❌ ไม่พบข้อมูลใบสั่งซื้อ ${poNo} ในระบบ`);
          }
          return;
        }

        if (repMatch) {
          const repairNo = repMatch[1].toUpperCase();
          const repair = getRepairs().find(r => r.repairNo === repairNo);
          if (repair) {
            if (repair.status !== 'รอดำเนินการ') {
              replyLineMessage(event.replyToken, `ℹ️ รายการแจ้งซ่อม ${repairNo} ได้รับการอนุมัติหรือดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${repair.status}"`);
            } else {
              replyLineFlex(event.replyToken, buildRepairFlexMessage(repair));
            }
          } else {
            replyLineMessage(event.replyToken, `❌ ไม่พบข้อมูลใบแจ้งซ่อม ${repairNo} ในระบบ`);
          }
          return;
        }

        // ── ลงทะเบียน Line ID ──
        // registerLineUserId(lineUserId, text);
        // replyLineMessage(event.replyToken,
        //   `👋 ระบบรับทราบแล้ว\nLine ID ของคุณ:\n${lineUserId}\n\nกรุณาแจ้ง Admin นำ ID นี้ไปกรอกในระบบ`
        // );
      }
    });

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── จัดการ Postback ──
function handlePostback(event) {
  const data       = event.postback.data;
  const replyToken = event.replyToken;
  const lineUserId = event.source.userId;
  const params     = parseQueryString(data);

  const action = params.action;
  const type   = params.type;
  const id     = params.id;

  // tech_done / tech_waiting / tech_report ไม่ต้องเช็คสิทธิ์ admin
  if (['tech_done', 'tech_waiting', 'tech_report'].includes(action)) {
    const user     = getNameByLineId(lineUserId);
    const techName = user ? user.name : 'ช่าง';
    if (action === 'tech_done') {
      const res = updateRepairStatus(id, 'เสร็จแล้ว');
      replyLineMessage(replyToken,
        res.success
          ? `✅ ${id} อัปเดตสถานะเป็น "เสร็จแล้ว" แล้ว\nโดย: ${techName}`
          : `❌ ${res.message}`
      );
    } else if (action === 'tech_waiting') {
      const res = updateRepairStatus(id, 'รออะไหล่');
      replyLineMessage(replyToken,
        res.success
          ? `📦 ${id} อัปเดตสถานะเป็น "รออะไหล่" แล้ว\nโดย: ${techName}`
          : `❌ ${res.message}`
      );
    } else if (action === 'tech_report') {
      const sheet = getSheetSafe('repairs');
      if (sheet) {
        const data = sheet.getDataRange().getValues();
        for (let i = 1; i < data.length; i++) {
          if (data[i][0] === id) {
            const curStatus = String(data[i][8] || '');
            // ── ถ้ารายงานแล้ว ──
            if (curStatus === 'เสร็จแล้ว') {
              replyLineMessage(
                replyToken,
                `⚠️ ${id} รายงานแล้ว\nหากต้องการแก้ไขรายงาน กรุณาแจ้งแอดมิน`
              );
              return;
            }
            break;
          }
        }
      }
      // ── เปิดให้พิมพ์รายงาน ──
      setPendingReport(lineUserId, id);
      replyLineMessage(
        replyToken,
        `✏️ ${techName} พิมพ์รายละเอียดงานได้เลยครับ`
      );
    }
    return;
  }
  // ── เช็คสิทธิ์ admin สำหรับ approve/reject ──
  if (!isLineUserAllowed(lineUserId, 'admin')) {
    replyLineMessage(replyToken,
      '⛔ คุณไม่มีสิทธิ์อนุมัติรายการนี้\nกรุณาติดต่อผู้ดูแลระบบ'
    );
    return;
  }
  const approver     = getNameByLineId(lineUserId);
  const approverName = approver ? approver.name : 'ไม่ทราบชื่อ';
  const dateStr      = formatDateTH(new Date().toISOString());

  // ── Repair ──
  if (type === 'repair') {
    const repairs   = getRepairs();
    const repair    = repairs.find(r => r.repairNo === id);
    const curStatus = repair?.status || '';
    if (curStatus !== 'รอดำเนินการ') {
      const alreadyDone = ['กำลังซ่อม','รออะไหล่','เสร็จแล้ว'].includes(curStatus);
      replyLineMessage(replyToken,
        alreadyDone
          ? `ℹ️ ${id} ได้รับการอนุมัติและดำเนินการไปแล้ว\nสถานะปัจจุบัน: "${curStatus}"`
          : `⚠️ ไม่สามารถดำเนินการได้\n${id} สถานะปัจจุบัน: "${curStatus}"`
      );
      return;
    }
    if (action === 'approve') {
      const res = updateRepairStatus(id, 'กำลังซ่อม');
      if (res.success) {
        saveApprovalInfo('repair', id, lineUserId);
        // ── ส่ง Flex ผลอนุมัติไปกลุ่ม (พร้อมปุ่มช่าง) ──
        const plate   = repair?.plate || '';
        replyLineFlex(replyToken, buildApprovalResultFlex('repair', id, approverName, dateStr, plate));
      } else {
        replyLineMessage(replyToken, `❌ เกิดข้อผิดพลาด: ${res.message}`);
      }
    } else {
      replyLineMessage(replyToken,
        `❌ ปฏิเสธการซ่อม ${id}\nโดย: ${approverName}`
      );
    }

  // ── PO ──
  } else if (type === 'po') {
    const pos       = getPOs();
    const po        = pos.find(p => p.poNo === id);
    const curStatus = po?.status || '';
    if (curStatus !== 'รออนุมัติ' && curStatus !== 'ออกPO') {
      replyLineMessage(replyToken,
        `⚠️ ไม่สามารถดำเนินการได้\n${id} สถานะปัจจุบัน: "${curStatus}" แล้ว`
      );
      return;
    }
    if (action === 'approve') {
      const res = updatePOStatus(id, 'อนุมัติแล้ว');
      if (res.success) {
        saveApprovalInfo('po', id, lineUserId);
        SpreadsheetApp.flush(); // Ensure approval info is written before PDF generation
        const pdfRes = generateAndSavePOPdf(id);
        const pdfUrl = (pdfRes && pdfRes.success) ? pdfRes.pdfUrl : '';
        const plate   = po?.plate || ''; 
        replyLineFlex(replyToken, buildPOApprovalFlex(id, approverName, dateStr, plate, pdfUrl));
      } else {
        replyLineMessage(replyToken, `❌ เกิดข้อผิดพลาด: ${res.message}`);
      }
    } else {
      replyLineMessage(replyToken,
        `❌ ปฏิเสธ PO ${id}\nโดย: ${approverName}`
      );
    }
  }
}

// ── รับรายงานจากช่าง ──
function handleTechReport(replyToken, lineUserId, refId, report) {
  const user     = getNameByLineId(lineUserId);
  const techName = user ? user.name : 'ช่าง';
  const isRepair = refId.startsWith('REP');

  let saved = false;
  let statusUpdated = false;

  if (isRepair) {
    const sheet = getSheetSafe('repairs');

    if (sheet) {
      const data = sheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {

        if (data[i][0] === refId) {

          // ── กันกดรายงานซ้ำ ──
          const curStatus = String(data[i][8] || '');

          if (curStatus === 'เสร็จแล้ว') {
            replyLineMessage(
              replyToken,
              `⚠️ ${refId} ถูกปิดงานแล้ว`
            );
            return;
          }

          // ── บันทึกรายงาน ──
          const existing = String(data[i][7] || '');

          const newNote = existing
            ? existing + '\n[' + formatDateTH(new Date().toISOString()) + ' ' + techName + ']: ' + report
            : '[' + formatDateTH(new Date().toISOString()) + ' ' + techName + ']: ' + report;

          sheet.getRange(i + 1, 8).setValue(newNote);

          saved = true;

          // ── ปิดงานทันที ──
          const updateRes = updateRepairStatus(refId, 'เสร็จแล้ว');
          if (updateRes.success) {
              statusUpdated = true;
            }

          break;
        }
      }
    }
  }

  // ── Reply Flex ──
  const token = getLineToken();

  callLineAPI('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [
      buildTechReportFlex(
        refId,
        techName,
        report,
        saved,
        statusUpdated,
        true
      )
    ]
  }, token);
}

// ============================================================
// NOTIFY FUNCTIONS
// ============================================================

function notifyRepairToLine(repair) {
  const token   = getLineToken();
  const groupId = getLineGroupId('service');
  if (!token || !groupId) return { success: false, message: 'ไม่พบ LINE config (TOKEN หรือ LINE_GROUP_ID_SERVICE)' };
  return callLineAPI('https://api.line.me/v2/bot/message/push', {
    to      : groupId,
    messages: [buildRepairFlexMessage(repair)]
  }, token);
}

function notifyPOToLine(po, items) {
  const token   = getLineToken();
  const groupId = getLineGroupId('po');
  if (!token || !groupId) return { success: false, message: 'ไม่พบ LINE config (TOKEN หรือ LINE_GROUP_ID_PO)' };
  return callLineAPI('https://api.line.me/v2/bot/message/push', {
    to      : groupId,
    messages: [buildPOFlexMessage(po, items)]
  }, token);
}

// ============================================================
// FLEX — แจ้งซ่อม
// ============================================================

function buildRepairFlexMessage(repair) {
  const statusColor = {
    'รอดำเนินการ': '#E8A838',
    'กำลังซ่อม'  : '#3B82F6',
    'รออะไหล่'   : '#8B5CF6',
    'เสร็จแล้ว'  : '#10B981'
  };
  const headerColor = statusColor[repair.status] || '#D97757';

  return {
    type    : 'flex',
    altText : `🔧 แจ้งซ่อมใหม่ | ${repair.repairNo} | ทะเบียน ${repair.plate}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        backgroundColor: headerColor,
        contents: [{
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '🔧', size: 'xxl', flex: 0 },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              contents: [
                { type: 'text', text: 'แจ้งซ่อมใหม่', color: '#ffffff', size: 'lg', weight: 'bold' },
                { type: 'text', text: repair.repairNo, color: '#FFE0D0', size: 'sm' }
              ]
            }
          ]
        }]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'vertical',
            backgroundColor: '#F0F4FF', cornerRadius: '8px', paddingAll: '12px',
            contents: [
              { type: 'text', text: '🚌 ทะเบียนรถ', size: 'xs', color: '#6B7280' },
              { type: 'text', text: repair.plate || '—', size: 'xl', weight: 'bold', color: '#1E3A5F', margin: 'xs' }
            ]
          },
          {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: [
              _flexInfoRow('📅 วันที่แจ้ง', formatDateTH(repair.date)),
              _flexInfoRow('📊 เลขไมล์', repair.mileage ? Number(repair.mileage).toLocaleString() + ' กม.' : '—'),
              _flexInfoRow('👤 ผู้แจ้ง', repair.createdBy || '—')
            ]
          },
          { type: 'separator', color: '#E5E7EB' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: '📋 รายการซ่อม', size: 'xs', color: '#6B7280', weight: 'bold' },
              { type: 'text', text: repair.repairList || '—', size: 'sm', color: '#111827', wrap: true, margin: 'xs' }
            ]
          }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [{
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            {
              type: 'button', style: 'primary', height: 'sm', color: '#10B981',
              action: { type: 'postback', label: '✅  อนุมัติ', data: `action=approve&type=repair&id=${repair.repairNo}`, displayText: `✅ อนุมัติการซ่อม ${repair.repairNo}` }
            },
            {
              type: 'button', style: 'primary', height: 'sm', color: '#EF4444',
              action: { type: 'postback', label: '❌  ปฏิเสธ', data: `action=reject&type=repair&id=${repair.repairNo}`,   displayText: `❌ ปฏิเสธการซ่อม ${repair.repairNo}`}
            }
          ]
        }]
      }
    }
  };
}

// ============================================================
// FLEX — ผลการอนุมัติ + ปุ่มช่าง
// ============================================================

function buildApprovalResultFlex(type, id, approverName, date, plate) {
  const isRepair = type === 'repair';
  const emoji    = isRepair ? '🔧' : '📋';
  const title    = isRepair ? 'อนุมัติการซ่อมแล้ว' : 'อนุมัติ PO แล้ว';

  return {
    type    : 'flex',
    altText : `✅ ${title} | ${id} | 🚌 ${plate || ''}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        backgroundColor: '#10B981',
        contents: [{
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '✅', size: 'xxl', flex: 0 },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              contents: [
                { type: 'text', text: title, color: '#ffffff', size: 'lg', weight: 'bold' },
                { type: 'text', text: id,    color: '#D1FAE5', size: 'sm' }
              ]
            }
          ]
        }]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          // ── เพิ่ม tag ทะเบียน ──
          ...(plate ? [{
            type: 'box', layout: 'horizontal',
            backgroundColor: '#1E3A5F', cornerRadius: '8px', paddingAll: '10px',
            contents: [
              { type: 'text', text: '🚌', size: 'sm', flex: 0 },
              { type: 'text', text: plate, size: 'lg', weight: 'bold',
                color: '#FFFFFF', margin: 'sm' }
            ]
          }] : []),
          _flexInfoRow('👤 ผู้อนุมัติ', approverName),
          _flexInfoRow('📅 เวลา',       date),
          { type: 'separator', color: '#E5E7EB' },
          {
            type: 'box', layout: 'vertical',
            backgroundColor: '#F0FDF4', cornerRadius: '8px', paddingAll: '12px',
            contents: [
              { type: 'text', text: `${emoji} ช่าง — กรุณาแจ้งสถานะงาน`,
                size: 'sm', color: '#065F46', weight: 'bold' },
              { type: 'text', text: 'กดปุ่มด้านล่าง หรือพิมพ์รายงานละเอียดเอง',
                size: 'xs', color: '#6B7280', wrap: true, margin: 'sm' }
            ]
          }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'secondary', height: 'sm',
            action: {
              type: 'postback', label: '✏️ พิมพ์รายงานเอง',
              data: `action=tech_report&type=${type}&id=${id}`,
              displayText: `รายงานการซ่อม ${id}: `
            }
          }
        ]
      }
    }
  };
}

// ============================================================
// FLEX — ใบสั่งซื้อ PO
// ============================================================

function buildPOFlexMessage(po, items) {
  const total    = (items || []).reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const totalStr = total.toLocaleString('th-TH', { minimumFractionDigits: 2 }) + ' บาท';

  const itemPreview = (items || []).slice(0, 4).map(i => ({
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: `• ${i.partName || '—'}`, size: 'xs', color: '#374151', flex: 5, wrap: true },
      { type: 'text', text: `${i.qty} ${i.unit || ''}`, size: 'xs', color: '#6B7280', flex: 2, align: 'end' }
    ]
  }));

  if ((items || []).length > 4) {
    itemPreview.push({
      type: 'text', text: `และอีก ${items.length - 4} รายการ...`,
      size: 'xs', color: '#9CA3AF', margin: 'xs'
    });
  }

  const footerContents = [{
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      {
        type: 'button', style: 'primary', height: 'sm', color: '#10B981',
        action: { type: 'postback', label: '✅  อนุมัติ', data: `action=approve&type=po&id=${po.poNo}`, displayText: `✅ อนุมัติ PO ${po.poNo}`}
      },
      {
        type: 'button', style: 'primary', height: 'sm', color: '#EF4444',
        action: { type: 'postback', label: '❌  ปฏิเสธ', data: `action=reject&type=po&id=${po.poNo}`, displayText: `❌ ปฏิเสธ PO ${po.poNo}` }
      }
    ]
  }];

  if (po.pdfUrl) {
    footerContents.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: '📄  ดูใบสั่งซื้อ PDF', uri: po.pdfUrl }
    });
  }

  return {
    type    : 'flex',
    altText : `📋 ขออนุมัติ PO ${po.poNo} | ${po.shopName} | ${totalStr}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        backgroundColor: '#1E3A5F',
        contents: [{
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '📋', size: 'xxl', flex: 0 },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              contents: [
                { type: 'text', text: 'ขออนุมัติใบสั่งซื้อ', color: '#ffffff', size: 'lg', weight: 'bold' },
                { type: 'text', text: po.poNo, color: '#B0C4DE', size: 'sm' }
              ]
            }
          ]
        }]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            backgroundColor: '#FFF7ED', cornerRadius: '8px', paddingAll: '12px',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1,
                contents: [
                  { type: 'text', text: '💰 ยอดรวมทั้งสิ้น', size: 'xs', color: '#92400E' },
                  { type: 'text', text: totalStr, size: 'lg', weight: 'bold', color: '#D97706', margin: 'xs' }
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1, alignItems: 'flex-end',
                contents: [
                  { type: 'text', text: 'จำนวนรายการ', size: 'xs', color: '#92400E', align: 'end' },
                  { type: 'text', text: `${(items || []).length} รายการ`, size: 'md', weight: 'bold', color: '#D97706', align: 'end', margin: 'xs' }
                ]
              }
            ]
          },
          {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: [
              _flexInfoRow('🏪 ร้านค้า',     po.shopName    || '—'),
              _flexInfoRow('🚌 ทะเบียน',     po.plate       || '—'),
              _flexInfoRow('🔧 อ้างอิงซ่อม', po.refRepairNo || '—'),
              _flexInfoRow('📅 วันที่',       formatDateTH(po.issueDate)),
              _flexInfoRow('👤 ผู้ขอ',       po.createdBy   || '—')
            ]
          },
          { type: 'separator', color: '#E5E7EB' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: '📦 รายการสินค้า', size: 'xs', color: '#6B7280', weight: 'bold' },
              ...itemPreview
            ]
          }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: footerContents
      }
    }
  };
}

// ============================================================
// FLEX — ใบอนุมัติ PO
// ============================================================
function buildPOApprovalFlex(poNo, approverName, date, plate, pdfUrl) {
  const contents = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      backgroundColor: '#10B981',
      contents: [{
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: '✅', size: 'xxl', flex: 0 },
          {
            type: 'box', layout: 'vertical', margin: 'sm',
            contents: [
              { type: 'text', text: 'อนุมัติใบสั่งซื้อแล้ว',
                color: '#ffffff', size: 'lg', weight: 'bold' },
              { type: 'text', text: poNo, color: '#D1FAE5', size: 'sm' }
            ]
          }
        ]
      }]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
      contents: [
        // ── เพิ่ม tag ทะเบียน ──
        ...(plate ? [{
          type: 'box', layout: 'horizontal',
          backgroundColor: '#1E3A5F', cornerRadius: '8px', paddingAll: '10px',
          contents: [
            { type: 'text', text: '🚌', size: 'sm', flex: 0 },
            { type: 'text', text: plate, size: 'lg', weight: 'bold',
              color: '#FFFFFF', margin: 'sm' }
          ]
        }] : []),
        {
          type: 'box', layout: 'vertical',
          backgroundColor: '#F0FDF4', cornerRadius: '8px', paddingAll: '12px',
          contents: [
            { type: 'text', text: '📋 รายละเอียดการอนุมัติ',
              size: 'xs', color: '#065F46', weight: 'bold' },
            {
              type: 'box', layout: 'vertical', margin: 'sm', spacing: 'xs',
              contents: [
                _flexInfoRow('📄 เลขที่ PO',  poNo),
                _flexInfoRow('👤 ผู้อนุมัติ', approverName),
                _flexInfoRow('📅 วันที่',      date)
              ]
            }
          ]
        },
        {
          type: 'box', layout: 'horizontal',
          backgroundColor: pdfUrl ? '#E8F5E9' : '#ECFDF5', cornerRadius: '8px', paddingAll: '10px',
          contents: [{
            type: 'text',
            text: pdfUrl ? '💡 สร้าง PDF ใบสั่งซื้อพร้อมลายเซ็นเรียบร้อยแล้ว' : '💡 ระบบกำลังสร้าง PDF ใบสั่งซื้ออัตโนมัติ',
            size: 'xs', color: pdfUrl ? '#2E7D32' : '#059669', wrap: true
          }]
        }
      ]
    }
  };

  if (pdfUrl) {
    contents.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
      contents: [{
        type: 'button', style: 'primary', height: 'sm', color: '#10B981',
        action: { type: 'uri', label: '📄 ดูใบสั่งซื้อ PDF', uri: pdfUrl }
      }]
    };
  }

  return {
    type   : 'flex',
    altText: `✅ อนุมัติ PO ${poNo} | 🚌 ${plate || ''} เรียบร้อย`,
    contents: contents
  };
}

// ============================================================
// FLEX - บันทึกรายการ
// ============================================================

function buildTechReportFlex(refId, techName, report, saved, statusUpdated, isDone) {
  const statusText = statusUpdated
    ? (isDone ? '✅ อัปเดตสถานะเป็น "เสร็จแล้ว"' : '📦 อัปเดตสถานะเป็น "รออะไหล่"')
    : null;

  return {
    type   : 'flex',
    altText: saved ? `✅ บันทึกรายงาน ${refId}` : `⚠️ ไม่พบ ${refId}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '14px',
        backgroundColor: saved ? '#10B981' : '#EF4444',
        contents: [{
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: saved ? '✅' : '⚠️', size: 'xl', flex: 0 },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              contents: [
                { type: 'text', text: saved ? 'บันทึกรายงานแล้ว' : 'ไม่พบรายการ', color: '#ffffff', size: 'md', weight: 'bold' },
                { type: 'text', text: refId, color: saved ? '#D1FAE5' : '#FEE2E2', size: 'sm' }
              ]
            }
          ]
        }]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
        contents: saved ? [
          {
            type: 'box', layout: 'vertical',
            backgroundColor: '#F0FDF4', cornerRadius: '8px', paddingAll: '12px',
            contents: [
              { type: 'text', text: `👷 ${techName}`, size: 'sm', weight: 'bold', color: '#065F46' },
              { type: 'text', text: report, size: 'sm', color: '#111827', wrap: true, margin: 'sm' }
            ]
          },
          _flexInfoRow('📋 งาน', refId),
          _flexInfoRow('📅 เวลา', formatDateTH(new Date().toISOString())),
          // แสดงสถานะที่อัปเดต ถ้ามี
          ...(statusText ? [{
            type: 'box', layout: 'horizontal',
            backgroundColor: isDone ? '#D1FAE5' : '#EDE9FE',
            cornerRadius: '6px', paddingAll: '8px', margin: 'sm',
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

// ============================================================
// HELPERS
// ============================================================

function _flexInfoRow(label, value) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label,              size: 'xs', color: '#6B7280', flex: 4 },
      { type: 'text', text: String(value || '—'), size: 'xs', color: '#111827', flex: 6, wrap: true, align: 'end' }
    ]
  };
}

function replyLineMessage(replyToken, text) {
  const token = getLineToken();
  if (!token) return;
  callLineAPI('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, token);
}

function replyLineFlex(replyToken, flexObj) {
  const token = getLineToken();
  if (!token) return;
  callLineAPI('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [flexObj]
  }, token);
}

function pushLineMessage(to, text) {
  const token = getLineToken();
  if (!token) return;
  callLineAPI('https://api.line.me/v2/bot/message/push', {
    to,
    messages: [{ type: 'text', text }]
  }, token);
}

function logLineMessage(url, payload, responseCode) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('LineLog');
    
    if (!sheet) {
      sheet = ss.insertSheet('LineLog');
      sheet.appendRow([
        'วันเวลา (Timestamp)', 
        'ประเภทคำสั่ง (API Method)', 
        'ประเภทข้อความ (Message Type)', 
        'ผู้รับ (Recipient ID)', 
        'รายละเอียด/ข้อความพรีวิว (Content Preview)', 
        'สถานะค่าบริการ (Cost Status)', 
        'HTTP Code'
      ]);
      sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#E2E8F0');
    }

    const timestamp = new Date();
    
    // ตรวจสอบเงื่อนไข Push (คิดเงิน) หรือ Reply (ฟรี) จาก URL
    const isPush = url.indexOf('/push') > -1;
    const methodType = isPush ? 'Push (บอททักก่อน)' : 'Reply (ตอบกลับแชท)';
    const costStatus = isPush ? 'คิดเงิน (Push)' : 'ฟรี (Reply)';
    
    let recipient = '';
    if (isPush) {
      recipient = payload.to || '';
    } else {
      recipient = 'Reply Token: ' + (payload.replyToken ? payload.replyToken.substring(0, 10) + '...' : '');
    }
    
    let msgType = 'unknown';
    let preview = '—';
    if (payload.messages && payload.messages.length > 0) {
      const firstMsg = payload.messages[0];
      msgType = firstMsg.type || 'unknown';
      if (msgType === 'text') {
        preview = firstMsg.text || '';
      } else if (msgType === 'flex') {
        preview = firstMsg.altText || 'Flex Message';
      }
    }
    
    sheet.appendRow([
      timestamp,
      methodType,
      msgType,
      recipient,
      preview,
      costStatus,
      responseCode
    ]);
  } catch (e) {
    Logger.log('logLineMessage error: ' + e.message);
  }
}

function callLineAPI(url, payload, token) {
  try {
    const res = UrlFetchApp.fetch(url, {
      method            : 'post',
      contentType       : 'application/json',
      headers           : { 'Authorization': 'Bearer ' + token },
      payload           : JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    
    // บันทึก Log การส่งข้อความ LINE
    logLineMessage(url, payload, code);
    
    return { success: code === 200, code, body: res.getContentText() };
  } catch (e) {
    // บันทึก Log กรณีเกิด Error
    logLineMessage(url, payload, 'ERROR: ' + e.message);
    return { success: false, message: e.message };
  }
}

function parseQueryString(qs) {
  const result = {};
  (qs || '').split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return result;
}

function formatDateTH(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    return (
      String(dt.getDate()).padStart(2, '0') + '/' +
      String(dt.getMonth() + 1).padStart(2, '0') + '/' +
      (dt.getFullYear() + 543)
    );
  } catch (e) { return String(d); }
}

// ============================================================
// TEST FUNCTIONS
// ============================================================

