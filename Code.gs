// ============================================================
// Code.gs — Bus Repair Management System
// Google Apps Script Backend
// ============================================================

// ---------- SHEET REGISTRY ----------
const SHEETS = {
  settings : 'Settings',
  users    : 'Users',
  buses    : 'Buses',
  repairs  : 'Repairs',
  parts    : 'RepairParts',
  po       : 'PurchaseOrders',
  poItems  : 'POItems',
  stock    : 'Stock',
  stockLog : 'StockLog',
  shops    : 'Shops',
  lineLog  : 'LineLog'
};

// ── ดึง sheet พร้อม guard (throw ถ้าไม่เจอ) ──
function getSheet(key) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS[key]);
  if (!sheet) throw new Error('ไม่พบชีท "' + SHEETS[key] + '"');
  return sheet;
}

// ── ดึง sheet แบบ safe (คืน null แทน throw) ──
function getSheetSafe(key) {
  try { return getSheet(key); } catch (e) { return null; }
}

// ---------- WEB APP ENTRY POINT ----------
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ระบบแจ้งซ่อมรถบัส')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------- SETTINGS ----------
function getCompanySettings() {
  try {
    const sheet = getSheetSafe('settings');
    if (!sheet) return {};
    const data = sheet.getDataRange().getValues();
    const result = {};
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) result[data[i][0]] = data[i][1];
    }
    return result;
  } catch(e) { return {}; }
}

function getSettingValue(key) {
  try {
    const sheet = getSheetSafe('settings');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) return data[i][1];
    }
    return null;
  } catch (e) { return null; }
}

function getAllSettings() {
  try {
    const sheet = getSheetSafe('settings');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const result = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) result.push({ key: data[i][0], value: data[i][1] });
    }
    return result;
  } catch (e) { return []; }
}

function saveSettings(settings) {
  try {
    const sheet = getSheet('settings');
    sheet.clearContents();
    sheet.appendRow(['Key', 'Value']);
    settings.forEach(s => sheet.appendRow([s.key, s.value]));
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- AUTH ----------
function login(username, password) {
  try {
    const sheet = getSheetSafe('users');
    if (!sheet) return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' };
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === username && data[i][2] === password && data[i][4] === 'active') {
        return {
          success: true,
          user: {
            id      : data[i][0],
            username: data[i][1],
            name    : data[i][3],
            role    : data[i][5],
            signatureUrl: String(data[i][7] || '')
          }
        };
      }
    }
    return { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- USERS ----------
function getUsers() {
  try {
    const sheet = getSheetSafe('users');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0]).map(r => ({
      id           : r[0],
      username     : r[1],
      name         : r[3],
      status       : r[4],
      role         : r[5],
      lineUserId   : String(r[6] || ''),
      signatureUrl : String(r[7] || '')
    }));
  } catch(e) { return []; }
}

function saveUser(user) {
  try {
    const sheet = getSheet('users');
    if (user.id) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === user.id) {
          sheet.getRange(i + 1, 1, 1, 8).setValues([[
            user.id, user.username,
            user.password || data[i][2],
            user.name, user.status, user.role,
            user.lineUserId || data[i][6] || '',
            user.signatureUrl || data[i][7] || ''
          ]]);
          return { success: true };
        }
      }
      return { success: false, message: 'ไม่พบผู้ใช้' };
    } else {
      const id = 'U' + Date.now();
      sheet.appendRow([
        id, user.username, user.password,
        user.name, user.status || 'active', user.role || 'user',
        user.lineUserId || '',
        user.signatureUrl || ''
      ]);
      return { success: true, id };
    }
  } catch(e) { return { success: false, message: e.message }; }
}

function deleteUser(id) {
  try {
    const sheet = getSheet('users');
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) { sheet.deleteRow(i + 1); return { success: true }; }
    }
    return { success: false, message: 'ไม่พบผู้ใช้' };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- SHOPS ✅ ----------
function getShops() {
  try {
    const s=getSheetSafe('shops'); if(!s) return [];
    const d=s.getDataRange().getValues();
    return d.slice(1).filter(r=>r[0]).map(r=>({
      id:String(r[0]||''), name:String(r[1]||''), address:String(r[2]||''),
      taxId:String(r[3]||''), phone:String(r[4]||''), note:String(r[5]||'')
    }));
  } catch(e){ return []; }
}
function saveShop(shop) {
  try {
    const s=getSheet('shops');
    if(shop.id){
      const d=s.getDataRange().getValues();
      for(let i=1;i<d.length;i++){
        if(d[i][0]===shop.id){
          s.getRange(i+1,1,1,6).setValues([[shop.id,shop.name,shop.address,shop.taxId,shop.phone,shop.note]]);
          return {success:true};
        }
      }
      return {success:false,message:'ไม่พบร้านค้า'};
    } else {
      const id='SHP'+Date.now();
      s.appendRow([id,shop.name,shop.address,shop.taxId,shop.phone||'',shop.note||'']);
      return {success:true,id};
    }
  } catch(e){ return {success:false,message:e.message}; }
}
function deleteShop(id) {
  try {
    const s=getSheet('shops'); const d=s.getDataRange().getValues();
    for(let i=1;i<d.length;i++) if(d[i][0]===id){s.deleteRow(i+1);return {success:true};}
    return {success:false,message:'ไม่พบร้านค้า'};
  } catch(e){ return {success:false,message:e.message}; }
}


// ---------- REPAIRS ----------
function generateRepairNumber() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const sheet  = getSheet('repairs');
  const data   = sheet.getDataRange().getValues();
  const prefix = 'REP' + yy + mm;
  let max = 0;
  data.slice(1).forEach(r => {
    if (String(r[0]).startsWith(prefix)) {
      const n = parseInt(String(r[0]).slice(-4));
      if (n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(4, '0');
}

function getRepairs() {
  try {
    const sheet = getSheetSafe('repairs');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0]).map(r => ({
      repairNo  : String(r[0] || ''),
      date: r[1] instanceof Date
        ? Utilities.formatDate(
            r[1],
            Session.getScriptTimeZone(),
            'yyyy-MM-dd'
          )
        : String(r[1] || ''),
      plate        : String(r[2] || ''),
      chassis      : String(r[3] || ''),
      mileage      : String(r[4] || ''),
      oilProgram   : String(r[5] || ''),
      repairList   : String(r[6] || ''),
      repairSummary: String(r[7] || ''),
      status    : String(r[8] || ''),
      createdBy : String(r[9] || ''),
      createdAt : r[10] instanceof Date
        ? r[10].toISOString()
        : String(r[10] || ''),
      approvedBy : String(r[11] || ''),
      approvedAt : String(r[12] || '')  
    }));

  } catch (e) {
    return [];
  }
}

function getRepairParts(repairNo) {
  try {
    const sheet = getSheetSafe('parts');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0] === repairNo).map(r => ({repairNo: r[0],partName: r[2],qty     : r[3]}));

  } catch (e) {
    return [];
  }
}

function saveRepair(repair, parts) {
  try {
    const repSheet   = getSheet('repairs');
    const partsSheet = getSheet('parts');
    let repairNo = repair.repairNo;
    
    if (repairNo) {
      // เช็คสถานะปัจจุบันก่อนบันทึกแก้ไข หากเสร็จแล้ว ห้ามแก้ไข
      const data = repSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === repairNo) {
          if (String(data[i][8] || '') === 'เสร็จแล้ว') {
            return { success: false, message: 'ไม่อนุญาตให้แก้ไขใบแจ้งซ่อมที่ปิดงานเสร็จสิ้นแล้ว' };
          }
          break;
        }
      }
    }

    if (!repairNo) {
      repairNo = generateRepairNumber();
      repSheet.appendRow([
        repairNo,
        repair.date,
        repair.plate,
        repair.chassis,
        repair.mileage,
        repair.oilProgram || '',
        repair.repairList || '',
        repair.repairSummary || '',
        'รอดำเนินการ',
        repair.createdBy,
        new Date().toISOString()
      ]);

    } else {
      const data = repSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === repairNo) {
          repSheet.getRange(i + 1, 1, 1, 11).setValues([[
            repairNo,
            repair.date,
            repair.plate,
            repair.chassis,
            repair.mileage,
            repair.oilProgram || '',
            repair.repairList || '',
            repair.repairSummary || '',
            data[i][8],   // status เดิม
            repair.createdBy,
            data[i][10]   // createdAt เดิม
          ]]);
          break;
        }
      }
      const pd = partsSheet.getDataRange().getValues();
      for (let i = pd.length - 1; i >= 1; i--) {
        if (pd[i][0] === repairNo) {
          partsSheet.deleteRow(i + 1);
        }
      }
    }
    (parts || []).forEach((p, idx) => {
      partsSheet.appendRow([
        repairNo,
        idx + 1,
        p.partName,
        p.qty
      ]);
    });
    return {
      success: true,
      repairNo
    };
  } catch (e) {
    return {
      success: false,
      message: e.message
    };
  }
}

// ── ส่งแจ้งซ่อมเข้า Line (เรียกจาก frontend) ──
function sendRepairToLine(repairNo) {
  try {
    const repairs = getRepairs();
    const repair  = repairs.find(r => r.repairNo === repairNo);
    if (!repair) return { success: false, message: 'ไม่พบรายการซ่อม' };

    // ถ้าอนุมัติไปแล้ว (สถานะไม่ใช่รอดำเนินการ) แจ้งเตือน
    if (repair.status !== 'รอดำเนินการ') {
      return {
        success    : false,
        alreadySent: true,
        message    : `รายการนี้สถานะเป็น "${repair.status}" แล้ว ไม่จำเป็นต้องส่งอนุมัติอีก`
      };
    }

    const sentAt = getLineSentStatus('repair', repairNo);
    if (sentAt) {
      return { 
        success    : false, 
        alreadySent: true,
        sentAt,
        message    : `ส่ง Line ไปแล้วเมื่อ ${sentAt}`
      };
    }

    const result = notifyRepairToLine(repair);
    if (result.success) markLineSent('repair', repairNo);
    return result;
  } catch (e) { return { success: false, message: e.message }; }
}

function forceSendRepairToLine(repairNo) {
  try {
    const repairs = getRepairs();
    const repair  = repairs.find(r => r.repairNo === repairNo);
    if (!repair) return { success: false, message: 'ไม่พบรายการซ่อม' };
    const result = notifyRepairToLine(repair);
    if (result.success) markLineSent('repair', repairNo);
    return result;
  } catch (e) { return { success: false, message: e.message }; }
}

function updateRepairStatus(repairNo, status) {
  try {
    const sheet = getSheet('repairs');
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === repairNo) {
        const oldStatus = String(data[i][8] || '');
        if (oldStatus === status) return { success: true };
        
        sheet.getRange(i + 1, 9).setValue(status);
        if (status === 'เสร็จแล้ว') {
          deductStockForRepair(repairNo);
        } else if (oldStatus === 'เสร็จแล้ว') {
          // หากย้อนกลับสถานะออกจาก "เสร็จแล้ว" ให้คืนสต็อก
          restoreStockForRepair(repairNo);
        }
        return { success: true };
      }
    }
    return { success: false, message: 'ไม่พบรายการซ่อม' };
  } catch (e) { return { success: false, message: e.message }; }
}

function deleteRepair(repairNo) {
  try {
    const repSheet   = getSheet('repairs');
    const partsSheet = getSheet('parts');

    const rd = repSheet.getDataRange().getValues();
    for (let i = rd.length - 1; i >= 1; i--) {
      if (rd[i][0] === repairNo) repSheet.deleteRow(i + 1);
    }
    const pd = partsSheet.getDataRange().getValues();
    for (let i = pd.length - 1; i >= 1; i--) {
      if (pd[i][0] === repairNo) partsSheet.deleteRow(i + 1);
    }
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- PURCHASE ORDERS ----------

function generateGrpRef() {
  const now    = new Date();
  const yyyy   = String(now.getFullYear());
  const mm     = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = 'GRP-' + yyyy + mm + '-';
  const sheet  = getSheetSafe('po');
  let max = 0;
  if (sheet) {
    const data    = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h || '').trim());
    const grpIdx  = headers.indexOf('GrpRef');
    if (grpIdx !== -1) {
      data.slice(1).forEach(r => {
        const val = String(r[grpIdx] || '');
        if (val.startsWith(prefix)) {
          const n = parseInt(val.slice(-3));
          if (n > max) max = n;
        }
      });
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

function generateQuoteNoAuto() {
  const now     = new Date();
  const yyyy    = String(now.getFullYear());
  const mm      = String(now.getMonth() + 1).padStart(2, '0');
  const dd      = String(now.getDate()).padStart(2, '0');
  const dateStr = yyyy + mm + dd;
  const prefix  = 'QT-' + dateStr + '-';
  const sheet   = getSheetSafe('po');
  let max = 0;
  if (sheet) {
    const data    = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h || '').trim());
    const qIdx    = headers.indexOf('QuoteNo');
    if (qIdx !== -1) {
      data.slice(1).forEach(r => {
        const val = String(r[qIdx] || '');
        if (val.startsWith(prefix)) {
          const n = parseInt(val.slice(-3));
          if (n > max) max = n;
        }
      });
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

function generatePONumber() {
  const now    = new Date();
  const yy     = String(now.getFullYear()).slice(-2);
  const mm     = String(now.getMonth() + 1).padStart(2, '0');
  const sheet  = getSheet('po');
  const data   = sheet.getDataRange().getValues();
  const prefix = 'PO' + yy + mm;
  let max = 0;
  data.slice(1).forEach(r => {
    if (String(r[0]).startsWith(prefix)) {
      const n = parseInt(String(r[0]).slice(-4));
      if (n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(4, '0');
}
function getPOs() {
  try {
    const sheet = getSheetSafe('po');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];

    const headers = data[0].map(h => String(h || '').trim());
    return data.slice(1).filter(r => r[0]).map(r => {
      const poRaw = {};
      headers.forEach((h, i) => { if (h) poRaw[h] = r[i]; });
      return {
        poNo        : String(poRaw.PONo || ''),
        shopName    : String(poRaw.ShopName || ''),
        shopAddress : String(poRaw.ShopAddress || ''),
        taxId       : String(poRaw.TaxID || ''),
        issueDate   : poRaw.IssueDate instanceof Date
          ? Utilities.formatDate(poRaw.IssueDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(poRaw.IssueDate || ''),
        quoteDate   : poRaw.QuoteDate instanceof Date
          ? Utilities.formatDate(poRaw.QuoteDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(poRaw.QuoteDate || ''),
        refRepairNo : String(poRaw.RefRepairNo || ''),
        quoteNo     : String(poRaw.QuoteNo || ''),
        plate       : String(poRaw.Plate || ''),
        vatType     : String(poRaw.VatType || ''),
        status      : String(poRaw.Status || ''),
        createdBy   : String(poRaw.CreatedBy || ''),
        createdAt   : poRaw.CreatedAt instanceof Date ? poRaw.CreatedAt.toISOString() : String(poRaw.CreatedAt || ''),
        createdBySignatureUrl: String(poRaw.createdBySignatureUrl || getUserSignatureByName(String(poRaw.CreatedBy || '')) || ''),
        approvedBy    : String(poRaw.approvedBy || ''),
        approvedAt    : String(poRaw.approvedAt || ''),
        lineSentAt    : String(poRaw.lineSentAt || ''),
        pdfUrl        : String(poRaw.pdfUrl || ''),
        printedAt     : String(poRaw.printedAt || ''),
        grpRef        : String(poRaw.GrpRef || ''),
        quoteNoIsAuto : String(poRaw.QuoteNoIsAuto || '') === 'true'
      };
    });
  } catch (e) { return []; }
}

function getPOItems(poNo) {
  try {
    const sheet = getSheetSafe('poItems');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0] === poNo).map(r => ({
      poNo: r[0], partName: r[2], qty: r[3],
      unit: r[4], pricePerUnit: r[5], discount: r[6], amount: r[7],
      note: String(r[8] || '')   // Log note
    }))
  } catch (e) { return []; }
}

function savePO(po, items) {
  try {
    const poSheet    = getSheet('po');
    const itemsSheet = getSheet('poItems');
    const headers    = ensurePOColumns();
    const colIdx     = name => headers.indexOf(name);
    let poNo = po.poNo;
    const createdBySignatureUrl = po.createdBySignatureUrl || getUserSignatureByName(po.createdBy) || '';

    // ── Auto-generate QuoteNo ถ้าช่องว่างเปล่า ──
    let quoteNo       = po.quoteNo || '';
    let quoteNoIsAuto = false;
    if (!quoteNo.trim()) {
      quoteNo       = generateQuoteNoAuto();
      quoteNoIsAuto = true;
    }

    // ── GrpRef: ใช้ที่ส่งมา หรือสร้างใหม่ ──
    let grpRef = po.grpRef || '';
    if (!grpRef.trim()) {
      grpRef = generateGrpRef();
    }

    if (!poNo) {
      poNo = generatePONumber();
      const row = headers.map(() => '');
      row[colIdx('PONo')] = poNo;
      row[colIdx('ShopName')] = po.shopName;
      row[colIdx('ShopAddress')] = po.shopAddress;
      row[colIdx('TaxID')] = po.taxId;
      row[colIdx('IssueDate')] = po.issueDate;
      row[colIdx('QuoteDate')] = po.quoteDate;
      row[colIdx('RefRepairNo')] = po.refRepairNo;
      row[colIdx('QuoteNo')] = quoteNo;
      row[colIdx('Plate')] = po.plate;
      row[colIdx('VatType')] = po.vatType;
      row[colIdx('Status')] = 'รออนุมัติ';
      row[colIdx('CreatedBy')] = po.createdBy;
      row[colIdx('CreatedAt')] = new Date().toISOString();
      row[colIdx('createdBySignatureUrl')] = createdBySignatureUrl;
      if (colIdx('GrpRef') !== -1)      row[colIdx('GrpRef')]      = grpRef;
      if (colIdx('QuoteNoIsAuto') !== -1) row[colIdx('QuoteNoIsAuto')] = quoteNoIsAuto ? 'true' : 'false';
      poSheet.appendRow(row);
    } else {
      const data = poSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === poNo) {
          const row = data[i].slice();
          while (row.length < headers.length) row.push('');
          row[colIdx('PONo')] = poNo;
          row[colIdx('ShopName')] = po.shopName;
          row[colIdx('ShopAddress')] = po.shopAddress;
          row[colIdx('TaxID')] = po.taxId;
          row[colIdx('IssueDate')] = po.issueDate;
          row[colIdx('QuoteDate')] = po.quoteDate;
          row[colIdx('RefRepairNo')] = po.refRepairNo;
          row[colIdx('QuoteNo')] = quoteNo;
          row[colIdx('Plate')] = po.plate;
          row[colIdx('VatType')] = po.vatType;
          row[colIdx('Status')] = data[i][colIdx('Status')] || 'รออนุมัติ';
          row[colIdx('CreatedBy')] = po.createdBy;
          row[colIdx('CreatedAt')] = data[i][colIdx('CreatedAt')] || new Date().toISOString();
          row[colIdx('createdBySignatureUrl')] = data[i][colIdx('createdBySignatureUrl')] || createdBySignatureUrl;
          // คง GrpRef เดิมไว้ถ้ามีแล้ว ไม่งั้นใช้ grpRef ใหม่
          if (colIdx('GrpRef') !== -1) {
            row[colIdx('GrpRef')] = String(data[i][colIdx('GrpRef')] || '') || grpRef;
          }
          if (colIdx('QuoteNoIsAuto') !== -1) {
            // อัปเดต QuoteNoIsAuto เฉพาะถ้าเป็น auto ใหม่
            row[colIdx('QuoteNoIsAuto')] = quoteNoIsAuto ? 'true' : (String(data[i][colIdx('QuoteNoIsAuto')] || 'false'));
          }
          poSheet.getRange(i + 1, 1, 1, headers.length).setValues([row]);
          // ดึง grpRef จริงจาก sheet (ในกรณี edit ใช้ grpRef เดิม)
          grpRef = row[colIdx('GrpRef')] || grpRef;
          break;
        }
      }
      const pd = itemsSheet.getDataRange().getValues();
      for (let i = pd.length - 1; i >= 1; i--) {
        if (pd[i][0] === poNo) itemsSheet.deleteRow(i + 1);
      }
    }

    (items || []).forEach((item, idx) => {
      itemsSheet.appendRow([poNo, idx + 1, item.partName, item.qty, item.unit, item.pricePerUnit, item.discount, item.amount, item.note || '']);
    });

    return { success: true, poNo, grpRef, quoteNo, quoteNoIsAuto };
  } catch (e) { return { success: false, message: e.message }; }
}

// ── ส่ง PO เข้า Line (เรียกจาก frontend) ──
function ensurePOColumns() {
  const sheet = getSheetSafe('po');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data.length ? data[0].map(h => String(h || '').trim()) : [];
  const required = ['PONo', 'ShopName', 'ShopAddress', 'TaxID', 'IssueDate', 'QuoteDate', 'RefRepairNo', 'QuoteNo', 'Plate', 'VatType', 'Status', 'CreatedBy', 'CreatedAt', 'createdBySignatureUrl', 'approvedBy', 'approvedAt', 'lineSentAt', 'pdfUrl', 'GrpRef', 'QuoteNoIsAuto'];

  let changed = false;
  required.forEach(name => {
    if (headers.indexOf(name) === -1) {
      headers.push(name);
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return headers;
}

function sendPOToLine(poNo) {
  try {
    const pos = getPOs();
    const po  = pos.find(p => p.poNo === poNo);
    
    // เช็คสถานะก่อน
    if (po && !['รออนุมัติ', 'ออกPO'].includes(po.status)) {
      return {
        success    : false,
        alreadySent: true,
        message    : `PO นี้สถานะเป็น "${po.status}" แล้ว ไม่จำเป็นต้องส่งอนุมัติอีก`
      };
    }

    const sentAt = getLineSentStatus('po', poNo);
    if (sentAt) {
      return {
        success    : false,
        alreadySent: true,
        sentAt,
        message    : `ส่ง Line ไปแล้วเมื่อ ${sentAt}`
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName('PurchaseOrders');
    if (!poSheet) return { success: false, message: 'ไม่พบชีต PurchaseOrders' };

    const data = poSheet.getDataRange().getValues();
    if (data.length < 2) return { success: false, message: 'ไม่มีข้อมูล PO' };

    const headers = data[0];
    const poNoIdx = headers.indexOf('PONo');
    if (poNoIdx === -1) return { success: false, message: 'ไม่พบคอลัมน์ PONo' };

    const row = data.find((r, i) =>
      i > 0 && String(r[poNoIdx]).trim() === String(poNo).trim()
    );
    if (!row) return { success: false, message: 'ไม่พบ PO: ' + poNo };

    // ── เปลี่ยนจาก "const po" เป็น "const poRaw" ──
    const poRaw = {};
    headers.forEach((h, i) => { poRaw[h] = row[i]; });

    const poObj = {
      poNo        : poRaw['PONo']        || '',
      shopName    : poRaw['ShopName']    || '',
      shopAddress : poRaw['ShopAddress'] || '',
      taxId       : poRaw['TaxID']       || '',
      issueDate   : poRaw['IssueDate']   || '',
      refRepairNo : poRaw['RefRepairNo'] || '',
      plate       : poRaw['Plate']       || '',
      vatType     : poRaw['VatType']     || 'none',
      createdBy   : poRaw['CreatedBy']   || '',
      pdfUrl      : poRaw['pdfUrl']      || ''
    };

    let items = [];
    const itemSheet = ss.getSheetByName('POItems');
    if (itemSheet) {
      const iData = itemSheet.getDataRange().getValues();
      if (iData.length > 1) {
        const iHdr     = iData[0];
        const iPoNoIdx = iHdr.findIndex(h => String(h).toLowerCase() === 'pono');
        items = iData.slice(1)
          .filter(r => String(r[iPoNoIdx]).trim() === String(poNo).trim())
          .map(r => {
            const obj = {};
            iHdr.forEach((h, i) => { obj[String(h).toLowerCase()] = r[i]; });
            return {
              partName     : obj['partname']     || '',
              qty          : Number(obj['qty'])          || 0,
              unit         : obj['unit']         || '',
              pricePerUnit : Number(obj['priceperunit']) || 0,
              discount     : Number(obj['discount'])     || 0,
              amount       : Number(obj['amount'])       || 0
            };
          });
      }
    }

    Logger.log('sendPOToLine => poNo=' + poObj.poNo + ', pdfUrl=' + poObj.pdfUrl + ', items=' + items.length);

    const result = notifyPOToLine(poObj, items);
    if (result.success) markLineSent('po', poNo);
    return result;

  } catch (e) {
    Logger.log('sendPOToLine error: ' + e.message);
    return { success: false, message: e.message };
  }
}

function sendPOsToLineQueue(poNos) {
  try {
    if (!Array.isArray(poNos) || !poNos.length) {
      return { success: false, message: 'ไม่พบรายการ PO ที่เลือก' };
    }

    const uniqueNos = [];
    poNos.forEach(poNo => {
      const cleanNo = String(poNo || '').trim();
      if (cleanNo && uniqueNos.indexOf(cleanNo) === -1) uniqueNos.push(cleanNo);
    });

    if (!uniqueNos.length) {
      return { success: false, message: 'ไม่พบรายการ PO ที่เลือก' };
    }

    const results = uniqueNos.map((poNo, idx) => {
      const res = sendPOToLine(poNo);
      if (idx < uniqueNos.length - 1) Utilities.sleep(300);
      return {
        poNo       : poNo,
        success    : !!(res && res.success),
        alreadySent: !!(res && res.alreadySent),
        code       : res && res.code,
        message    : (res && (res.message || res.body)) || ''
      };
    });

    return {
      success: true,
      total  : uniqueNos.length,
      sent   : results.filter(r => r.success).length,
      skipped: results.filter(r => !r.success && r.alreadySent).length,
      failed : results.filter(r => !r.success && !r.alreadySent).length,
      results: results
    };
  } catch (e) {
    Logger.log('sendPOsToLineQueue error: ' + e.message);
    return { success: false, message: e.message };
  }
}

function forceSendPOToLine(poNo) {
  try {
    const pos = getPOs();
    const po  = pos.find(p => p.poNo === poNo);
    if (!po) return { success: false, message: 'ไม่พบ PO: ' + poNo };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName('PurchaseOrders');
    if (!poSheet) return { success: false, message: 'ไม่พบชีต PurchaseOrders' };

    const data = poSheet.getDataRange().getValues();
    const headers = data[0];
    const poNoIdx = headers.indexOf('PONo');
    const row = data.find((r, i) => i > 0 && String(r[poNoIdx]).trim() === String(poNo).trim());
    if (!row) return { success: false, message: 'ไม่พบ PO: ' + poNo };

    const poRaw = {};
    headers.forEach((h, i) => { poRaw[h] = row[i]; });

    const poObj = {
      poNo        : poRaw['PONo']        || '',
      shopName    : poRaw['ShopName']    || '',
      shopAddress : poRaw['ShopAddress'] || '',
      taxId       : poRaw['TaxID']       || '',
      issueDate   : poRaw['IssueDate']   || '',
      refRepairNo : poRaw['RefRepairNo'] || '',
      plate       : poRaw['Plate']       || '',
      vatType     : poRaw['VatType']     || 'none',
      createdBy   : poRaw['CreatedBy']   || '',
      pdfUrl      : poRaw['pdfUrl']      || ''
    };

    let items = [];
    const itemSheet = ss.getSheetByName('POItems');
    if (itemSheet) {
      const iData = itemSheet.getDataRange().getValues();
      if (iData.length > 1) {
        const iHdr     = iData[0];
        const iPoNoIdx = iHdr.findIndex(h => String(h).toLowerCase() === 'pono');
        items = iData.slice(1)
          .filter(r => String(r[iPoNoIdx]).trim() === String(poNo).trim())
          .map(r => {
            const obj = {};
            iHdr.forEach((h, i) => { obj[String(h).toLowerCase()] = r[i]; });
            return {
              partName     : obj['partname']     || '',
              qty          : Number(obj['qty'])          || 0,
              unit         : obj['unit']         || '',
              pricePerUnit : Number(obj['priceperunit']) || 0,
              discount     : Number(obj['discount'])     || 0,
              amount       : Number(obj['amount'])       || 0
            };
          });
      }
    }

    const result = notifyPOToLine(poObj, items);
    if (result.success) markLineSent('po', poNo);
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}


function updatePOStatus(poNo, status, approvedBy, syncStock) {
  try {
    approvedBy = approvedBy || '';
    syncStock  = syncStock !== false;

    const sheet   = getSheet('po');
    const data    = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h || '').trim());

    const statusIdx   = headers.indexOf('Status');
    const approvedByIdx = headers.indexOf('approvedBy');
    const approvedAtIdx = headers.indexOf('approvedAt');

    if (statusIdx < 0) return { success: false, message: 'ไม่พบ column Status' };

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === poNo) {
        // อัปเดต Status
        sheet.getRange(i + 1, statusIdx + 1).setValue(status);

        // อัปเดต approvedBy / approvedAt เมื่ออนุมัติ
        if (status === 'อนุมัติแล้ว') {
          if (approvedByIdx >= 0) sheet.getRange(i + 1, approvedByIdx + 1).setValue(approvedBy);
          if (approvedAtIdx >= 0) sheet.getRange(i + 1, approvedAtIdx + 1).setValue(new Date().toISOString());
        }

        // รับของแล้ว → sync stock
        if (status === 'รับของแล้ว' && syncStock) {
          addStockFromPO(poNo);
          syncPOPartsToRepair(poNo);
        }

        return { success: true };
      }
    }
    return { success: false, message: 'ไม่พบ PO' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ── sync อะไหล่จาก PO ไปใส่ใน RepairParts ──
function syncPOPartsToRepair(poNo) {
  try {
    const poSheet    = getSheet('po');
    const poData     = poSheet.getDataRange().getValues();
    const partsSheet = getSheet('parts');

    // หา refRepairNo จาก PO
    let refRepairNo = '';
    for (let i = 1; i < poData.length; i++) {
      if (poData[i][0] === poNo) {
        refRepairNo = String(poData[i][6] || ''); // col 7 = refRepairNo
        break;
      }
    }
    if (!refRepairNo) return { success: false, message: 'ไม่พบเลขจ็อบซ่อม' };

    // ดึง PO items
    const items = getPOItems(poNo);
    if (!items.length) return { success: true };

    // ดึง repair parts ที่มีอยู่แล้วเพื่อตรวจเช็ค
    const existingParts = partsSheet.getDataRange().getValues();

    // ดำเนินการอัปเดตหรือเพิ่มรายการใหม่
    items.forEach((item, idx) => {
      const name = String(item.partName || '').trim();
      if (!name) return;

      let foundRowIndex = -1;
      // ค้นหาแถวที่มี refRepairNo และ PartName ตรงกัน (case-insensitive)
      for (let i = 1; i < existingParts.length; i++) {
        if (existingParts[i][0] === refRepairNo && 
            String(existingParts[i][2] || '').trim().toLowerCase() === name.toLowerCase()) {
          foundRowIndex = i;
          break;
        }
      }

      if (foundRowIndex >= 0) {
        // หากเคยมีอยู่แล้วในจ็อบซ่อมนี้ ให้บวกจำนวนเพิ่มเข้าไปในเซลล์เดิม (คอลัมน์ที่ 4 ของชีท parts)
        const currentQty = parseFloat(existingParts[foundRowIndex][3]) || 0;
        const addQty     = parseFloat(item.qty) || 0;
        const newQty     = currentQty + addQty;
        partsSheet.getRange(foundRowIndex + 1, 4).setValue(newQty);
        
        // อัปเดตข้อมูลจำลองในอาเรย์ด้วย เผื่อกรณีใน PO ใบนี้หรือใบถัดไปมีรายการซ้ำกันอีก
        existingParts[foundRowIndex][3] = newQty;
      } else {
        // หากยังไม่มี ให้บันทึกเป็นรายการใหม่
        const newRow = [refRepairNo, Date.now() + idx, name, item.qty];
        partsSheet.appendRow(newRow);
        
        // อัปเดตข้อมูลจำลองในอาเรย์เพื่อใช้เช็คในลูปรายการถัดไป
        existingParts.push(newRow);
      }
    });

    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}

function deletePO(poNo) {
  try {
    const poSheet    = getSheet('po');
    const itemsSheet = getSheet('poItems');

    const pd = poSheet.getDataRange().getValues();
    let poRowIndex = -1;
    let poStatus = '';
    for (let i = 1; i < pd.length; i++) {
      if (pd[i][0] === poNo) {
        poRowIndex = i;
        poStatus = String(pd[i][10] || ''); // col 11 = Status
        break;
      }
    }
    
    if (poRowIndex < 0) return { success: false, message: 'ไม่พบ PO: ' + poNo };
    
    // บล็อกไม่อนุญาตให้ลบ PO ที่อนุมัติแล้ว หรือรับของแล้ว
    if (poStatus === 'รับของแล้ว' || poStatus === 'อนุมัติแล้ว') {
      return { success: false, message: 'ไม่อนุญาตให้ลบใบ PO ที่มีสถานะ "' + poStatus + '" กรุณายกเลิกหรือเปลี่ยนสถานะก่อน' };
    }

    poSheet.deleteRow(poRowIndex + 1);
    
    const id = itemsSheet.getDataRange().getValues();
    for (let i = id.length - 1; i >= 1; i--) {
      if (id[i][0] === poNo) itemsSheet.deleteRow(i + 1);
    }
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- STOCK ----------
function generatePartCode() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const sheet  = getSheet('stock');
  const data   = sheet.getDataRange().getValues();
  const prefix = 'PRT' + yy + mm;
  let max = 0;
  data.slice(1).forEach(r => {
    if (String(r[1]).startsWith(prefix)) {
      const n = parseInt(String(r[1]).slice(-3));
      if (n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(3, '0');
}

function getStock() {
  try {
    const sheet = getSheetSafe('stock');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();

    // ดึงราคาซื้อล่าสุดจาก poItems
    const poItemsSheet = getSheetSafe('poItems');
    const lastPrices = {};
    if (poItemsSheet) {
      const poItemsData = poItemsSheet.getDataRange().getValues();
      // แถวที่เขียนทีหลัง (ด้านล่าง) จะทับแถวที่เขียนก่อนหน้า ซึ่งหมายถึงเป็นราคาล่าสุด
      for (let i = 1; i < poItemsData.length; i++) {
        const partName = String(poItemsData[i][2] || '').trim();
        const price = parseFloat(poItemsData[i][5]) || 0;
        if (partName) {
          lastPrices[partName.toLowerCase()] = price;
        }
      }
    }

    return data.slice(1).filter(r => r[0]).map(r => {
      const partName = String(r[2] || '').trim();
      const partNameKey = partName.toLowerCase();
      return {
        id: r[0], partCode: r[1], partName: r[2], unit: r[3],
        qty: r[4], minQty: r[5], location: r[6], note: r[7],
        lastPrice: lastPrices[partNameKey] || 0
      };
    });
  } catch (e) { return []; }
}

function saveStockItem(item) {
  try {
    const sheet = getSheet('stock');
    if (item.id) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === item.id) {
          sheet.getRange(i + 1, 1, 1, 8).setValues([[
            item.id, item.partCode, item.partName, item.unit,
            item.qty, item.minQty, item.location, item.note
          ]]);
          return { success: true };
        }
      }
      return { success: false, message: 'ไม่พบรายการ' };
    } else {
      const id       = 'STK' + Date.now();
      const partCode = item.partCode || generatePartCode();
      sheet.appendRow([id, partCode, item.partName, item.unit, item.qty, item.minQty, item.location, item.note]);
      return { success: true, id, partCode };
    }
  } catch (e) { return { success: false, message: e.message }; }
}

function deleteStockItem(id) {
  try {
    const sheet = getSheet('stock');
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) { sheet.deleteRow(i + 1); return { success: true }; }
    }
    return { success: false, message: 'ไม่พบรายการ' };
  } catch (e) { return { success: false, message: e.message }; }
}

function addStockFromPO(poNo) {
  try {
    const items      = getPOItems(poNo);
    const stockSheet = getSheet('stock');
    items.forEach(item => {
      const data = stockSheet.getDataRange().getValues();
      let found = false;
      for (let i = 1; i < data.length; i++) {
        if (data[i][2] === item.partName) {
          const newQty = (parseFloat(data[i][4]) || 0) + parseFloat(item.qty);
          stockSheet.getRange(i + 1, 5).setValue(newQty);
          found = true; break;
        }
      }
      if (!found) {
        const newPartCode = generatePartCode(); // ← เพิ่มบรรทัดนี้
        stockSheet.appendRow([
          'STK' + Date.now(),
          newPartCode,
          item.partName, 
          item.unit, 
          item.qty, 
          0, '', 
          'นำเข้าจาก PO: ' + poNo
        ]);
      }
      logStockTransaction('IN', item.partName, item.qty, 'PO: ' + poNo);
    });
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}
function deductStockForRepair(repairNo) {
  try {
    const stockSheet = getSheet('stock');
    const logSheet   = getSheetSafe('stockLog');
    if (!logSheet) return;

    // เช็คประวัติป้องกันการตัดสต็อกซ้ำซ้อน
    const logData = logSheet.getDataRange().getValues();
    for (let i = 1; i < logData.length; i++) {
      if (String(logData[i][1]) === 'OUT' && String(logData[i][4]) === 'Repair: ' + repairNo) {
        return; // เคยตัดแล้ว ข้ามเลยเพื่อความปลอดภัย
      }
    }

    const parts = getRepairParts(repairNo);
    if (!parts || !parts.length) return;

    const stockData = stockSheet.getDataRange().getValues();

    parts.forEach(part => {
      for (let i = 1; i < stockData.length; i++) {
        const stockPartName = String(stockData[i][2] || '').trim().toLowerCase();
        const repairPartName = String(part.partName || '').trim().toLowerCase();

        if (stockPartName === repairPartName) {
          const currentQty = parseFloat(stockData[i][4] || 0);
          const deductQty  = parseFloat(part.qty || 0);
          const newQty     = Math.max(0, currentQty - deductQty);

          stockSheet.getRange(i + 1, 5).setValue(newQty);

          // log
          logSheet.appendRow([
            new Date(),
            'OUT',
            part.partName,
            deductQty,
            'Repair: ' + repairNo
          ]);

          break;
        }
      }
    });
  } catch (e) { /* ignore */ }
}

function restoreStockForRepair(repairNo) {
  try {
    const stockSheet = getSheet('stock');
    const logSheet   = getSheetSafe('stockLog');
    if (!logSheet) return { success: false, message: 'ไม่พบชีทสต็อกล็อก' };

    const logData   = logSheet.getDataRange().getValues();
    const stockData = stockSheet.getDataRange().getValues();

    // ค้นหาย้อนหลังจากล่างขึ้นบนเพื่อความปลอดภัยในการลบแถว
    let restoredCount = 0;
    for (let i = logData.length - 1; i >= 1; i--) {
      const type = String(logData[i][1] || '');
      const ref  = String(logData[i][4] || '');

      if (type === 'OUT' && ref === 'Repair: ' + repairNo) {
        const partName = String(logData[i][2] || '').trim().toLowerCase();
        const qty      = parseFloat(logData[i][3]) || 0;

        // บวกคืนเข้าคลัง Stock
        for (let j = 1; j < stockData.length; j++) {
          if (String(stockData[j][2] || '').trim().toLowerCase() === partName) {
            const currentQty = parseFloat(stockData[j][4] || 0);
            stockSheet.getRange(j + 1, 5).setValue(currentQty + qty);
            stockData[j][4] = currentQty + qty; // อัปเดตข้อมูลจำลอง
            break;
          }
        }

        // ลบแถวประวัติออก
        logSheet.deleteRow(i + 1);
        restoredCount++;
      }
    }
    return { success: true, restoredCount };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function logStockTransaction(type, partName, qty, ref) {
  try {
    const sheet = getSheetSafe('stockLog');
    if (!sheet) return;
    const logId = 'LOG' + Date.now() + '_' + Math.floor(Math.random() * 10000); 
    sheet.appendRow([new Date().toISOString(), type, partName, qty, ref, logId]);
  } catch (e) { /* ignore */ }
}

function manualDeductStock(items, date, plate, note) {
  try {
    const stockSheet = getSheet('stock');
    const results = [];

    items.forEach(item => {
      const data = stockSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === item.stockId) {
          const currentQty = parseFloat(data[i][4]) || 0;
          const deductQty  = parseFloat(item.qty)   || 0;
          const newQty     = Math.max(0, currentQty - deductQty);
          const price      = parseFloat(item.pricePerUnit) || 0;

          stockSheet.getRange(i + 1, 5).setValue(newQty);

         
          const logId = 'LOG' + Date.now() + '_' + Math.floor(Math.random() * 10000);
          const ref = `วันที่:${date} | ทะเบียน:${plate} | ราคา:${price} | หมายเหตุ:${note || '-'}`;
          
          const logSheet = getSheetSafe('stockLog');
          if (logSheet) {
            logSheet.appendRow([new Date().toISOString(), 'OUT-MANUAL', data[i][2], deductQty, ref, logId]);
          }

          results.push({ 
            partName: data[i][2], 
            stockId : item.stockId,
            before  : currentQty, 
            after   : newQty,
            logId  
          });
          break;
        }
      }
    });

    return { success: true, results };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function cancelDeductStock(logId) {
  try {
    if (!logId) return { success: false, message: 'logId ไม่ถูกต้อง' };
    const logSheet   = getSheet('stockLog');
    const stockSheet = getSheet('stock');
    const logData    = logSheet.getDataRange().getValues();

    // หา log row จาก logId (col index 5)
    let targetRow = -1;
    let partName  = '';
    let qty       = 0;

    for (let i = 1; i < logData.length; i++) {
      if (String(logData[i][5] || '') === logId) {
        // เช็คว่ายกเลิกไปแล้วหรือยัง
        if (String(logData[i][1]) === 'CANCEL') {
          return { success: false, message: 'รายการนี้ถูกยกเลิกไปแล้ว' };
        }
        targetRow = i;
        partName  = String(logData[i][2] || '');
        qty       = parseFloat(logData[i][3]) || 0;
        break;
      }
    }

    if (targetRow < 0) return { success: false, message: 'ไม่พบ logId: ' + logId };

    // บวกจำนวนคืนใน Stock
    const stockData = stockSheet.getDataRange().getValues();
    let restored = false;
    for (let i = 1; i < stockData.length; i++) {
      if (String(stockData[i][2] || '') === partName) {
        const currentQty = parseFloat(stockData[i][4]) || 0;
        stockSheet.getRange(i + 1, 5).setValue(currentQty + qty);
        restored = true;
        break;
      }
    }

    if (!restored) return { success: false, message: 'ไม่พบอะไหล่ "' + partName + '" ใน Stock' };

    // อัปเดต type เป็น CANCEL ใน log
    logSheet.getRange(targetRow + 1, 2).setValue('CANCEL');

    // อัปเดต Ref โดยใส่ข้อมูลการยกเลิกต่อท้ายแถวเดิม
    const origRef = String(logData[targetRow][4] || '');
    const timestampStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const cancelRef = origRef + ' (ยกเลิกเมื่อ ' + timestampStr + ')';
    logSheet.getRange(targetRow + 1, 5).setValue(cancelRef);

    return { success: true, partName, qty };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getStockLog(limit) {
  try {
    const sheet = getSheetSafe('stockLog');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const rows = data.slice(1).filter(r => r[0]).map(r => ({
      timestamp : r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''),
      type      : String(r[1] || ''),
      partName  : String(r[2] || ''),
      qty       : parseFloat(r[3]) || 0,
      ref       : String(r[4] || ''),
      logId     : String(r[5] || '')
    }));
    rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return limit ? rows.slice(0, limit) : rows;
  } catch(e) { return []; }
}

// ---------- BUSES ----------
function getBusPlates() {
  try {
    const sheet = getSheetSafe('buses');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0]).map(r => ({ plate: r[0], chassis: r[1] }));
  } catch (e) { return []; }
}

function getFullBuses() {
  try {
    Logger.log('getFullBuses called at: ' + new Date().toISOString());
    const sheet = getSheetSafe('buses');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const result = data.slice(1).filter(r => r[0]).map(r => ({
      plate           : String(r[0] || ''),
      chassis         : String(r[1] || ''),
      model           : String(r[2] || ''),
      year            : String(r[3] || ''),
      color           : String(r[4] || ''),
      engineNo        : String(r[5] || ''),
      lastInspect     : r[6] instanceof Date ? r[6].toISOString() : String(r[6] || ''),
      regExpiry       : r[7] instanceof Date ? r[7].toISOString() : String(r[7] || ''),
      insuranceExpiry : r[8] instanceof Date ? r[8].toISOString() : String(r[8] || ''),
      note            : String(r[9] || '')
    }));
    Logger.log('result count: ' + result.length);
    return result;
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
    return [];
  }
}

function saveBus(bus) {
  try {
    const sheet = getSheet('buses');
    const data  = sheet.getDataRange().getValues();
    const row   = [
      bus.plate, bus.chassis, bus.model, bus.year,
      bus.color, bus.engineNo, bus.lastInspect,
      bus.regExpiry, bus.insuranceExpiry, bus.note
    ];
    const searchPlate = bus.oldPlate || bus.plate;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === searchPlate) {
        sheet.getRange(i + 1, 1, 1, 10).setValues([row]);
        return { success: true };
      }
    }
    sheet.appendRow(row);
    return { success: true };
  } catch (e) { return { success: false, message: e.message }; }
}

function deleteBus(plate) {
  try {
    const sheet = getSheet('buses');
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === plate) { sheet.deleteRow(i + 1); return { success: true }; }
    }
    return { success: false, message: 'ไม่พบรถ' };
  } catch (e) { return { success: false, message: e.message }; }
}

// ---------- SUMMARY ----------

function getExpenseSummary(filter) {
  try {
    // ── ส่วน PO เดิม ──
    const pos     = getPOs();
    const poItems = getSheet('poItems').getDataRange().getValues();

    const poTotals = {};
    poItems.slice(1).forEach(r => {
      const poNo = String(r[0] || '');
      const amt  = parseFloat(r[7]) || 0;
      if (!poTotals[poNo]) poTotals[poNo] = 0;
      poTotals[poNo] += amt;
    });

    const from = filter?.from ? new Date(filter.from) : null;
    const to   = filter?.to   ? new Date(filter.to)   : null;
    if (to) to.setHours(23, 59, 59);

    const filteredPO = pos.filter(p => {
      if (p.status !== 'รับของแล้ว') return false;
      const d = new Date(p.issueDate);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      if (filter?.plate    && p.plate    !== filter.plate)    return false;
      if (filter?.shopName && p.shopName !== filter.shopName) return false;
      return true;
    }).map(p => ({ ...p, total: poTotals[p.poNo] || 0, source: 'PO' }));

    // ── ส่วน Manual Deduct ──
    const logSheet = getSheetSafe('stockLog');
    const manualRows = [];

    if (logSheet) {
      const logData = logSheet.getDataRange().getValues();
      logData.slice(1).forEach(r => {
        if (String(r[1]) !== 'OUT-MANUAL') return;

        // parse ref string "วันที่:xxx | ทะเบียน:xxx | ราคา:xxx | หมายเหตุ:xxx"
        const ref      = String(r[4] || '');
        const getVal   = key => (ref.match(new RegExp(key + ':([^|]+)')) || [])[1]?.trim() || '';
        const dateStr  = getVal('วันที่');
        const plate    = getVal('ทะเบียน');
        const price    = parseFloat(getVal('ราคา')) || 0;
        const noteStr  = getVal('หมายเหตุ');
        const qty      = parseFloat(r[3]) || 0;
        const amount   = price * qty;

        if (!dateStr || !plate) return;

        const d = new Date(dateStr);
        if (from && d < from) return;
        if (to   && d > to)   return;
        if (filter?.plate && plate !== filter.plate) return;

        manualRows.push({
          poNo      : 'MANUAL',
          issueDate : dateStr,
          plate,
          shopName  : '— ตัดโดยตรง —',
          refRepairNo: noteStr,
          total     : amount,
          source    : 'MANUAL',
          partName  : String(r[2] || ''),
          qty
        });
      });
    }

    // ── รวมทั้งหมด ──
    const allRows = [...filteredPO, ...manualRows];
    const grandTotal = allRows.reduce((s, r) => s + r.total, 0);

    // สรุปตามรถ
    const byPlate = {};
    allRows.forEach(r => {
      if (!byPlate[r.plate]) byPlate[r.plate] = 0;
      byPlate[r.plate] += r.total;
    });

    // สรุปตามร้านค้า (Manual จะขึ้นเป็น "— ตัดโดยตรง —")
    const byShop = {};
    allRows.forEach(r => {
      if (!byShop[r.shopName]) byShop[r.shopName] = 0;
      byShop[r.shopName] += r.total;
    });

    // สรุปตามเดือน
    const byMonth = {};
    allRows.forEach(r => {
      const d   = new Date(r.issueDate);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!byMonth[key]) byMonth[key] = 0;
      byMonth[key] += r.total;
    });

    return {
      success : true,
      total   : grandTotal,
      count   : allRows.length,
      byPlate : Object.entries(byPlate)
                  .map(([plate, total]) => ({ plate, total }))
                  .sort((a, b) => b.total - a.total),
      byShop  : Object.entries(byShop)
                  .map(([shop, total]) => ({ shop, total }))
                  .sort((a, b) => b.total - a.total),
      byMonth : Object.entries(byMonth)
                  .map(([month, total]) => ({ month, total }))
                  .sort((a, b) => a.month.localeCompare(b.month)),
      detail  : allRows.sort((a, b) => new Date(b.issueDate) - new Date(a.issueDate))
    };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// ---------- WEEKLY SUMMARY ----------
function getWeeklySummary(weekOffset) {
  try {
    weekOffset = parseInt(weekOffset) || 0;

    // คำนวณช่วงสัปดาห์ (จันทร์–อาทิตย์)
    const now    = new Date();
    const day    = now.getDay(); // 0=อาทิตย์
    const diff   = (day === 0 ? -6 : 1 - day); // offset ไป จันทร์
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const repairs = getRepairs();

    // งานที่ "เปิด" ในสัปดาห์นี้ (createdAt อยู่ในช่วง)
    const openedThisWeek = repairs.filter(r => {
      const d = new Date(r.createdAt || r.date);
      return d >= monday && d <= sunday;
    });

    // งานที่ยังค้าง ณ ปัจจุบัน (ไม่สนใจช่วงวันที่)
    const allPending = repairs.filter(r => r.status !== 'เสร็จแล้ว');

    // งานที่ปิดสำเร็จในสัปดาห์นี้
    // ใช้ createdAt เป็น proxy เพราะยังไม่มี closedAt
    // (ถ้าอนาคตเพิ่ม closedAt ให้เปลี่ยนตรงนี้)
    const doneThisWeek = repairs.filter(r => {
      if (r.status !== 'เสร็จแล้ว') return false;
      const d = new Date(r.createdAt || r.date);
      return d >= monday && d <= sunday;
    });

    // งานค้างข้ามสัปดาห์ (เปิดก่อนสัปดาห์นี้ ยังไม่เสร็จ)
    const carryOver = repairs.filter(r => {
      if (r.status === 'เสร็จแล้ว') return false;
      const d = new Date(r.createdAt || r.date);
      return d < monday;
    });

    // สรุปตามสถานะ (งานค้างทั้งหมด)
    const byStatus = {};
    allPending.forEach(r => {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    });

    // รถที่ซ่อมบ่อยสุด (จากงานที่เปิดสัปดาห์นี้)
    const byPlate = {};
    openedThisWeek.forEach(r => {
      byPlate[r.plate] = (byPlate[r.plate] || 0) + 1;
    });
    const topPlates = Object.entries(byPlate)
      .map(([plate, count]) => ({ plate, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // รายการค้างทั้งหมด (สำหรับ Modal detail)
    const pendingDetails = allPending
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return {
      success      : true,
      weekLabel    : _formatWeekLabel(monday, sunday),
      monday       : monday.toISOString(),
      sunday       : sunday.toISOString(),
      weekOffset,
      openedCount  : openedThisWeek.length,
      doneCount    : doneThisWeek.length,
      pendingCount : allPending.length,
      carryOverCount: carryOver.length,
      byStatus,
      topPlates,
      pendingDetails
    };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

function _formatWeekLabel(monday, sunday) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const fmt = d =>
    `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

// ---------- LINE Section -------------

// ── เช็คว่า Job/PO นี้เคยส่ง Line ไปแล้วหรือยัง ──
function getLineSentStatus(type, id) {
  try {
    const sheetKey = type === 'repair' ? 'repairs' : 'po';
    const sheet    = getSheetSafe(sheetKey);
    if (!sheet) return null;

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];

    // หา column lineSentAt (ถ้าไม่มีคืน null)
    const colIdx = headers.indexOf('lineSentAt');
    if (colIdx < 0) return null;

    const idColIdx = 0; // RepairNo / PONo อยู่ col แรก
    const row = data.find((r, i) => i > 0 && String(r[idColIdx]).trim() === String(id).trim());
    if (!row) return null;

    return row[colIdx] ? String(row[colIdx]) : null;
  } catch (e) { return null; }
}
// ── บันทึกเวลาที่ส่ง Line ──
function markLineSent(type, id) {
  try {
    const sheetKey = type === 'repair' ? 'repairs' : 'po';
    const sheet    = getSheetSafe(sheetKey);
    if (!sheet) return;

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    let colIdx    = headers.indexOf('lineSentAt');

    // ถ้ายังไม่มี column ให้สร้างใหม่ที่ท้าย
    if (colIdx < 0) {
      colIdx = headers.length;
      sheet.getRange(1, colIdx + 1).setValue('lineSentAt');
    }

    const idColIdx = 0;
    const rowIdx   = data.findIndex((r, i) =>
      i > 0 && String(r[idColIdx]).trim() === String(id).trim()
    );
    if (rowIdx > 0) {
      sheet.getRange(rowIdx + 1, colIdx + 1).setValue(new Date().toISOString());
    }
  } catch (e) { Logger.log('markLineSent error: ' + e.message); }
}

// ---------- LINE USER ID HELPERS ----------
function getNameByLineId(lineUserId) {
  try {
    const sheet = getSheetSafe('users');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    // lineUserId อยู่ col index 6 (คอลัมน์ที่ 7)
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][6] || '') === String(lineUserId)) {
        return { id: data[i][0], name: data[i][3], role: data[i][5] };
      }
    }
    return null;
  } catch(e) { return null; }
}

function isLineUserAllowed(lineUserId, requiredRole) {
  const user = getNameByLineId(lineUserId);
  if (!user) return false;
  if (requiredRole === 'admin') return user.role === 'admin';
  return true; // role=user ก็ผ่าน
}

// ── ให้ผู้ใช้ลงทะเบียน lineUserId ด้วยตัวเอง
// เรียกจาก doPost เมื่อมีคนส่งข้อความมาที่ Bot
function registerLineUserId(lineUserId, displayName) {
  try {
    const sheet = getSheetSafe('users');
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    // เช็คว่ามี lineUserId นี้แล้วหรือยัง
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][6] || '') === lineUserId) return; // มีแล้ว ไม่ต้องทำอะไร
    }
    // Log ไว้ใน StockLog ชั่วคราว เผื่อ admin เอาไปกรอกเอง
    logStockTransaction('LINE_REG', displayName, 0, 'lineUserId: ' + lineUserId);
  } catch(e) {}
}

// ---------- APPROVAL LOG ----------
function saveApprovalInfo(type, id, lineUserId) {
  try {
    const sheetKey = type === 'repair' ? 'repairs' : 'po';
    const sheet    = getSheetSafe(sheetKey);
    if (!sheet) return { success: false };

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];

    // สร้าง column approvedBy, approvedAt ถ้ายังไม่มี
    let byIdx = headers.indexOf('approvedBy');
    let atIdx = headers.indexOf('approvedAt');
    if (byIdx < 0) byIdx = 15; 
    if (atIdx < 0) atIdx = 16;
    if (byIdx < 0) {
      byIdx = headers.length;
      sheet.getRange(1, byIdx + 1).setValue('approvedBy');
    }
    if (atIdx < 0) {
      atIdx = headers.length + (byIdx === headers.length ? 1 : 0);
      sheet.getRange(1, atIdx + 1).setValue('approvedAt');
    }

    // หา row ที่ตรงกับ id
    const idColIdx = 0;
    const rowIdx   = data.findIndex((r, i) =>
      i > 0 && String(r[idColIdx]).trim() === String(id).trim()
    );
    if (rowIdx < 0) return { success: false };

    // ดึงข้อมูล user จาก lineUserId
    const approver = getNameByLineId(lineUserId);
    const name     = approver ? approver.name : lineUserId;

    sheet.getRange(rowIdx + 1, byIdx + 1).setValue(name);
    sheet.getRange(rowIdx + 1, atIdx + 1).setValue(new Date().toISOString());

    return { success: true, approverName: name, approver };
  } catch(e) {
    Logger.log('saveApprovalInfo error: ' + e.message);
    return { success: false };
  }
}

// แก้เป็น — เพิ่ม debug log และ normalize
function getApproverSignature(approvedBy) {
  if (!approvedBy || approvedBy.trim() === "") return "";

  const trimmed = approvedBy.trim();

  // ถ้าเป็น URL อยู่แล้ว ให้คืนตรงๆ
  if (trimmed.startsWith('http')) {
    return trimmed;
  }

  const sig = getUserSignatureByName(trimmed);
  if (sig) return sig;

  Logger.log('getApproverSignature: NOT found for approvedBy=[' + trimmed + ']');
  return '';
}

function getUserSignatureByName(name) {
  if (!name || !String(name).trim()) return '';
  const trimmed = String(name).trim();
  const users = getUsers();
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].name || '').trim() === trimmed) {
      Logger.log('getUserSignatureByName: found user=' + users[i].name + ', signatureUrl=' + users[i].signatureUrl);
      return users[i].signatureUrl || '';
    }
  }
  Logger.log('getUserSignatureByName: NOT found for name=[' + trimmed + ']');
  return '';
}


// ── แปลง Google Drive URL ทุกรูปแบบ → thumbnail URL ──
function convertDriveUrl(url) {
  if (!url) return '';

  const match =
    url.match(/\/d\/([-\w]+)/) ||
    url.match(/[?&]id=([-\w]+)/);

  if (match) {
    return 'https://drive.google.com/uc?export=view&id=' + match[1];
  }

  return url;
}

function convertDriveUrlToThumbnail(url) {
  if (!url) return '';
  const match = url.match(/\/d\/([-\w]+)/) || url.match(/[?&]id=([-\w]+)/);
  if (match) {
    return 'https://drive.google.com/thumbnail?id=' + match[1] + '&sz=w400';
  }
  return url;
}

// ── ดึงข้อมูล PO พร้อม approvedBy + signatureUrl ครบในครั้งเดียว ──
function getPOForPrint(poNo) {
  try {
    const pos = getPOs();
    const po  = pos.find(p => p.poNo === poNo);
    if (!po) return null;

    const items    = getPOItems(poNo);
    const settings = getAllSettings();

    // ── Debug ──
    Logger.log('getPOForPrint: poNo=' + poNo);
    Logger.log('po.approvedBy = [' + po.approvedBy + ']');
    Logger.log('po.approvedAt = [' + po.approvedAt + ']');
    Logger.log('po.createdBy = [' + po.createdBy + ']');
    Logger.log('po.createdBySignatureUrl = [' + (po.createdBySignatureUrl || '') + ']');

    const sigUrl = po.approvedBy
  ? convertDriveUrlToThumbnail(getApproverSignature(po.approvedBy))
  : '';
    Logger.log('sigUrl = [' + sigUrl + ']');

    return { po, items, sigUrl, settings };
  } catch(e) { 
    Logger.log('getPOForPrint error: ' + e.message);
    return null; 
  }
}

// ---------- OIL TEMPLATES ----------
function getOilTemplates() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet()
                    .getSheetByName('OilTemplates');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    return data.slice(1).filter(r => r[0] && r[1]).map(r => ({
      plate        : String(r[0] || '').trim(),
      program      : String(r[1] || '').trim(),
      partName     : String(r[2] || ''),
      qty          : parseFloat(r[3]) || 1,
      unit         : String(r[4] || 'ชิ้น'),
      pricePerUnit : parseFloat(r[5]) || 0
    }));
  } catch(e) {
    Logger.log('getOilTemplates error: ' + e.message);
    return [];
  }
}

function getOilTemplateItems(program, plate) {
  if (!program || !plate) return [];
  const all = getOilTemplates();
  return all.filter(t => t.plate === plate && t.program === program);
}

function saveOilTemplate(plate, program, items) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let sheet   = ss.getSheetByName('OilTemplates');

    // สร้าง sheet ถ้ายังไม่มี
    if (!sheet) {
      sheet = ss.insertSheet('OilTemplates');
      sheet.appendRow(['Plate','Program','PartName','Qty','Unit','PricePerUnit']);
    }

    const data = sheet.getDataRange().getValues();

    // ลบแถวเดิมของ plate+program นี้ก่อน
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() === plate &&
          String(data[i][1]).trim() === program) {
        sheet.deleteRow(i + 1);
      }
    }

    // เพิ่มแถวใหม่
    items.forEach(item => {
      sheet.appendRow([
        plate, program,
        item.partName,
        item.qty,
        item.unit,
        item.pricePerUnit || 0
      ]);
    });

    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

function getOilTemplateByPlateProgram(plate, program) {
  if (!plate || !program) return [];
  return getOilTemplates().filter(
    t => t.plate === plate && t.program === program
  );
}

// ดึงรายการโปรแกรมที่มีอยู่แล้วของรถคันนี้
function getOilProgramsByPlate(plate) {
  if (!plate) return [];
  const all = getOilTemplates();
  const programs = [...new Set(
    all.filter(t => t.plate === plate).map(t => t.program)
  )];
  return programs;
}

// ---------- Notification Bell ----------
function getNotifications() {
  try {
    const repairs = getRepairs();
    const pos = getPOs();
    const notifications = [];

    // PO อนุมัติแล้ว รอปริ้น
    pos.filter(p => p.status === 'อนุมัติแล้ว').forEach(p => {
      notifications.push({
        id      : p.poNo,
        type    : 'po_approved',
        title   : 'PO อนุมัติแล้ว',
        body    : `${p.poNo} | ${p.shopName}`,
        action  : 'po',
        ref     : p.poNo,
        date    : p.approvedAt || p.issueDate
      });
    });

    // Job ซ่อมอนุมัติแล้ว (กำลังซ่อม) รอแจ้งช่าง
    repairs.filter(r => r.status === 'กำลังซ่อม').forEach(r => {
      notifications.push({
        id      : r.repairNo,
        type    : 'repair_approved',
        title   : 'อนุมัติซ่อมแล้ว',
        body    : `${r.repairNo} | ${r.plate}`,
        action  : 'repairs',
        ref     : r.repairNo,
        date    : r.approvedAt || r.date
      });
    });

    // PO รออนุมัติ (สำหรับ admin)
    pos.filter(p => p.status === 'รออนุมัติ').forEach(p => {
      notifications.push({
        id      : p.poNo,
        type    : 'po_pending',
        title   : 'PO รออนุมัติ',
        body    : `${p.poNo} | ${p.shopName}`,
        action  : 'po',
        ref     : p.poNo,
        date    : p.issueDate
      });
    });

    // Stock ใกล้หมด
    const stock = getStock();
    stock.filter(s => parseFloat(s.qty) <= parseFloat(s.minQty || 0) && parseFloat(s.minQty) > 0)
      .forEach(s => {
        notifications.push({
          id      : s.id,
          type    : 'stock_low',
          title   : 'อะไหล่ใกล้หมด',
          body    : `${s.partName} เหลือ ${s.qty} ${s.unit}`,
          action  : 'stock',
          ref     : s.id,
          date    : new Date().toISOString()
        });
      });

    return notifications.sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch(e) { return []; }
}

// ---------- INIT: Create all sheets if not exist ----------
function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetsConfig = {
    [SHEETS.settings] : ['Key', 'Value'],
    [SHEETS.users] : ['ID','Username','Password','Name','Status','Role','LineUserID','SignatureUrl'],
    [SHEETS.buses]    : ['Plate', 'Chassis', 'Model', 'Year', 'Color', 'EngineNo', 'LastInspect', 'RegExpiry', 'InsuranceExpiry', 'Note'],
    [SHEETS.repairs]  : ['RepairNo', 'Date', 'Plate', 'Chassis', 'Mileage', 'RepairList','repairSummary', 'Status', 'CreatedBy', 'CreatedAt'],
    [SHEETS.parts]    : ['RepairNo', 'PartName', 'Qty'],
    [SHEETS.po] : ['PONo', 'ShopName', 'ShopAddress', 'TaxID', 'IssueDate', 'QuoteDate', 'RefRepairNo', 'QuoteNo', 'Plate', 'VatType', 'Status', 'CreatedBy', 'CreatedAt', 'createdBySignatureUrl', 'approvedBy', 'approvedAt', 'lineSentAt', 'pdfUrl', 'printedAt'],
    [SHEETS.poItems]  : ['PONo', 'No', 'PartName', 'Qty', 'Unit', 'PricePerUnit', 'Discount', 'Amount', 'Note'],
    [SHEETS.stock]    : ['ID', 'PartCode', 'PartName', 'Unit', 'Qty', 'MinQty', 'Location', 'Note'],
    [SHEETS.stockLog] : ['Timestamp', 'Type', 'PartName', 'Qty', 'Ref', 'LogId'],
    [SHEETS.shops]    :['ID','Name','Address','TaxID','Phone','Note'],
    'OilTemplates' : ['TemplateID','Program','Plate','PartName','Qty','Unit','PricePerUnit']
  };

  Object.entries(sheetsConfig).forEach(([name, headers]) => {
    if (!ss.getSheetByName(name)) {
      ss.insertSheet(name).appendRow(headers);
    }
  });

  // เพิ่ม admin เริ่มต้นถ้ายังไม่มี
  const usersSheet = ss.getSheetByName(SHEETS.users);
  if (usersSheet && usersSheet.getLastRow() <= 1) {
    usersSheet.appendRow(['U001', 'admin', 'admin1234', 'ผู้ดูแลระบบ',  'active', 'admin']);
    usersSheet.appendRow(['U002', 'user',  'user1234',  'ผู้ใช้ทั่วไป', 'active', 'user']);
  }

  return { success: true, message: 'สร้างชีทเรียบร้อยแล้ว' };
}

// บันทึกสถานะการพิมพ์ใบ PO
function markPOAsPrinted(poNo) {
  try {
    const sheet = getSheet('po');
    const data  = sheet.getDataRange().getValues();
    const headers = data[0];
    let printedAtIdx = headers.indexOf('printedAt');
    
    // หากยังไม่มีคอลัมน์ printedAt ให้สร้างเพิ่มแบบไดนามิก
    if (printedAtIdx < 0) {
      printedAtIdx = headers.length;
      sheet.getRange(1, printedAtIdx + 1).setValue('printedAt');
    }
    
    const poNoColIdx = 0; // PONo อยู่คอลัมน์แรก (Index 0)
    const rowIdx = data.findIndex((r, i) => i > 0 && String(r[poNoColIdx]).trim() === String(poNo).trim());
    
    if (rowIdx > 0) {
      sheet.getRange(rowIdx + 1, printedAtIdx + 1).setValue(new Date().toISOString());
      return { success: true };
    }
    return { success: false, message: 'ไม่พบ PO' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ---------- LINE MESSAGE LOGGING ----------
function getLineLogs() {
  try {
    const sheet = getSheetSafe('lineLog');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    
    // เรียงจากใหม่สุดไปเก่าสุด
    return data.slice(1).reverse().map(r => ({
      timestamp  : r[0] instanceof Date 
        ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') 
        : String(r[0] || ''),
      method     : String(r[1] || ''),
      msgType    : String(r[2] || ''),
      recipient  : String(r[3] || ''),
      preview    : String(r[4] || ''),
      costStatus : String(r[5] || ''),
      code       : String(r[6] || '')
    }));
  } catch (e) { return []; }
}

function clearLineLogs() {
  try {
    const sheet = getSheetSafe('lineLog');
    if (!sheet) return { success: false, message: 'ไม่พบชีต LineLog' };
    
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    }
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
