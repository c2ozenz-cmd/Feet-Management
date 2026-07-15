/**
 * Google Apps Script to Supabase Data Migration Utility (Robust Version)
 * Paste this into your Google Apps Script Editor (Extensions > Apps Script)
 * to migrate all existing data from Google Sheets to Supabase.
 */

const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_SERVICE_ROLE_KEY = "YOUR_SUPABASE_SERVICE_ROLE_KEY";

function runDataMigration() {
  Logger.log("Starting migration to Supabase...");
  
  try {
    // 1. Gather valid keys to prevent Foreign Key constraints violations
    const validPlates = getValidPlates();
    const validRepairNos = getValidRepairNos();
    const validPOs = getValidPONos();

    Logger.log(`Found: ${validPlates.size} plates, ${validRepairNos.size} repairs, ${validPOs.size} POs in spreadsheet.`);

    // 2. Perform Migration in order of dependency
    migrateSettings();
    migrateBuses();
    migrateShops();
    migrateStock();
    migrateProfiles();
    migrateRepairs(validPlates);
    migrateRepairParts(validRepairNos);
    migratePurchaseOrders(validRepairNos, validPlates);
    migratePOItems(validPOs);
    migrateOilTemplates(validPlates);
    
    Logger.log("🎉 Data migration completed successfully!");
  } catch (e) {
    Logger.log("❌ Migration failed: " + e.message + "\n" + e.stack);
  }
}

// ── DATA GATHERING HELPERS ──
function getValidPlates() {
  const data = getSheetData("Buses") || [];
  const plates = new Set();
  data.forEach(r => {
    const plate = String(r.plate || r.Plate || '').trim();
    if (plate) plates.add(plate);
  });
  return plates;
}

function getValidRepairNos() {
  const data = getSheetData("Repairs") || [];
  const repairNos = new Set();
  data.forEach(r => {
    const rNo = String(r.repairNo || r.repair_no || '').trim();
    if (rNo) repairNos.add(rNo);
  });
  return repairNos;
}

function getValidPONos() {
  const data = getSheetData("PurchaseOrders") || [];
  const poNos = new Set();
  data.forEach(r => {
    const poNo = String(r.PONo || r.poNo || r.po_no || '').trim();
    if (poNo) poNos.add(poNo);
  });
  return poNos;
}

function getSheetData(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log(`Warning: Sheet "${sheetName}" not found.`);
    return null;
  }
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(h => String(h || '').trim());
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = row[idx];
    });
    return obj;
  });
}

function postToSupabase(table, payload) {
  if (!payload || payload.length === 0) return;
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const options = {
    method: "POST",
    contentType: "application/json",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "resolution=merge-duplicates" // upsert on conflict
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code >= 200 && code < 300) {
    Logger.log(`✅ Successfully migrated ${payload.length} rows to "${table}"`);
  } else {
    throw new Error(`Failed to upload to "${table}". Code: ${code}. Response: ${response.getContentText()}`);
  }
}

// ── TABLE MIGRATORS ──

function migrateSettings() {
  const rows = getSheetData("Settings") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    key: String(r.Key || r.key || ''),
    value: String(r.Value || r.value || '')
  })).filter(r => r.key);
  
  postToSupabase("settings", payload);
}

function migrateBuses() {
  const rows = getSheetData("Buses") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    plate: String(r.plate || r.Plate || '').trim(),
    chassis: String(r.chassis || r.Chassis || ''),
    model: String(r.model || r.Model || ''),
    year: String(r.year || r.Year || ''),
    color: String(r.color || r.Color || ''),
    engine_no: String(r.engineNo || r.engine_no || ''),
    last_inspect: r.lastInspect instanceof Date ? Utilities.formatDate(r.lastInspect, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    reg_expiry: r.regExpiry instanceof Date ? Utilities.formatDate(r.regExpiry, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    insurance_expiry: r.insuranceExpiry instanceof Date ? Utilities.formatDate(r.insuranceExpiry, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    note: String(r.note || '')
  })).filter(r => r.plate);
  
  postToSupabase("buses", payload);
}

function migrateShops() {
  const rows = getSheetData("Shops") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    id: String(r.id || ''),
    name: String(r.name || ''),
    address: String(r.address || ''),
    tax_id: String(r.taxId || r.tax_id || ''),
    phone: String(r.phone || ''),
    note: String(r.note || '')
  })).filter(r => r.id && r.name);
  
  postToSupabase("shops", payload);
}

function migrateStock() {
  const rows = getSheetData("Stock") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    id: String(r.id || ''),
    part_code: String(r.partCode || r.part_code || ''),
    part_name: String(r.partName || r.part_name || ''),
    unit: String(r.unit || 'ชิ้น'),
    qty: parseFloat(r.qty) || 0,
    min_qty: parseFloat(r.minQty || r.min_qty) || 0,
    location: String(r.location || ''),
    note: String(r.note || '')
  })).filter(r => r.id && r.part_name);
  
  postToSupabase("stock", payload);
}

function migrateRepairs(validPlates) {
  const rows = getSheetData("Repairs") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rawPlate = String(r.plate || '').trim();
    // Validate Foreign Key for Plate
    const plate = validPlates.has(rawPlate) ? rawPlate : null;

    return {
      repair_no: String(r.repairNo || r.repair_no || ''),
      date: r.date instanceof Date ? Utilities.formatDate(r.date, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      plate: plate,
      chassis: String(r.chassis || ''),
      mileage: parseInt(r.mileage) || 0,
      oil_program: String(r.oilProgram || r.oil_program || ''),
      repair_list: String(r.repairList || r.repair_list || ''),
      repair_summary: String(r.repairSummary || r.repair_summary || ''),
      status: String(r.status || 'รอดำเนินการ'),
      created_by: String(r.createdBy || r.created_by || ''),
      created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : null,
      approved_by: String(r.approvedBy || r.approved_by || ''),
      approved_at: String(r.approvedAt || r.approved_at || '')
    };
  }).filter(r => r.repair_no);
  
  postToSupabase("repairs", payload);
}

function migrateRepairParts(validRepairNos) {
  const rows = getSheetData("RepairParts") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rNo = String(r.repairNo || r.repair_no || '').trim();
    return {
      repair_no: rNo,
      part_name: String(r.partName || r.part_name || ''),
      qty: parseFloat(r.qty) || 1
    };
  }).filter(r => r.repair_no && r.part_name && validRepairNos.has(r.repair_no)); // Skip orphan parts
  
  postToSupabase("repair_parts", payload);
}

function migratePurchaseOrders(validRepairNos, validPlates) {
  const rows = getSheetData("PurchaseOrders") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rawRepNo = String(r.RefRepairNo || r.ref_repair_no || '').trim();
    // Validate Foreign Key for Repair No
    const refRepairNo = validRepairNos.has(rawRepNo) ? rawRepNo : null;

    const rawPlate = String(r.Plate || r.plate || '').trim();
    // Validate Foreign Key for Plate
    const plate = validPlates.has(rawPlate) ? rawPlate : null;

    return {
      po_no: String(r.PONo || r.poNo || r.po_no || ''),
      shop_name: String(r.ShopName || r.shop_name || ''),
      shop_address: String(r.ShopAddress || r.shop_address || ''),
      tax_id: String(r.TaxID || r.tax_id || ''),
      issue_date: r.IssueDate instanceof Date ? Utilities.formatDate(r.IssueDate, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      quote_date: r.QuoteDate instanceof Date ? Utilities.formatDate(r.QuoteDate, Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      ref_repair_no: refRepairNo,
      quote_no: String(r.QuoteNo || r.quote_no || ''),
      plate: plate,
      vat_type: String(r.VatType || r.vat_type || 'none'),
      status: String(r.Status || r.status || 'รออนุมัติ'),
      created_by: String(r.CreatedBy || r.created_by || ''),
      created_at: r.CreatedAt instanceof Date ? r.CreatedAt.toISOString() : null,
      created_by_signature_url: String(r.createdBySignatureUrl || r.created_by_signature_url || ''),
      approved_by: String(r.approvedBy || r.approved_by || ''),
      approved_at: String(r.approvedAt || r.approved_at || ''),
      line_sent_at: String(r.lineSentAt || r.line_sent_at || ''),
      pdf_url: String(r.pdfUrl || r.pdf_url || ''),
      grp_ref: String(r.GrpRef || r.grp_ref || ''),
      quote_no_is_auto: r.QuoteNoIsAuto === true || r.QuoteNoIsAuto === 'TRUE'
    };
  }).filter(r => r.po_no);
  
  postToSupabase("purchase_orders", payload);
}

function migratePOItems(validPOs) {
  const rows = getSheetData("POItems") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const poNo = String(r.PONo || r.poNo || r.po_no || '').trim();
    return {
      po_no: poNo,
      part_name: String(r.PartName || r.part_name || ''),
      qty: parseFloat(r.Qty || r.qty) || 1,
      unit: String(r.Unit || r.unit || 'ชิ้น'),
      price_per_unit: parseFloat(r.PricePerUnit || r.price_per_unit) || 0,
      discount: parseFloat(r.Discount || r.discount) || 0,
      amount: parseFloat(r.Amount || r.amount) || 0,
      note: String(r.Note || r.note || '')
    };
  }).filter(r => r.po_no && r.part_name && validPOs.has(r.po_no)); // Skip orphan PO items
  
  postToSupabase("po_items", payload);
}

function migrateOilTemplates(validPlates) {
  const rows = getSheetData("OilTemplates") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rawPlate = String(r.plate || r.Plate || '').trim();
    return {
      plate: rawPlate,
      program: String(r.program || r.Program || ''),
      part_name: String(r.partName || r.part_name || ''),
      qty: parseFloat(r.qty) || 1,
      unit: String(r.unit || 'ชิ้น'),
      price_per_unit: parseFloat(r.pricePerUnit || r.price_per_unit) || 0
    };
  }).filter(r => r.plate && r.program && validPlates.has(r.plate)); // Skip orphan templates
  
  postToSupabase("oil_templates", payload);
}

function migrateProfiles() {
  const rows = getSheetData("Users") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    id: String(r.id || ''),
    username: String(r.username || '').trim(),
    password: String(r.password || ''),
    name: String(r.name || ''),
    status: String(r.status || 'active'),
    role: String(r.role || 'user'),
    line_user_id: String(r.lineUserId || r.line_user_id || ''),
    signature_url: String(r.signatureUrl || r.signature_url || '')
  })).filter(r => r.id && r.username);
  
  postToSupabase("profiles", payload);
}

