/**
 * Google Apps Script to Supabase Data Migration Utility (Index-Based Version)
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

    Logger.log(`Found in sheets: ${validPlates.size} plates, ${validRepairNos.size} repairs, ${validPOs.size} POs.`);

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
  const rows = getSheetData("Buses") || [];
  const plates = new Set();
  rows.forEach(r => {
    const plate = String(r[0] || '').trim();
    if (plate) plates.add(plate);
  });
  return plates;
}

function getValidRepairNos() {
  const rows = getSheetData("Repairs") || [];
  const repairNos = new Set();
  rows.forEach(r => {
    const rNo = String(r[0] || '').trim();
    if (rNo) repairNos.add(rNo);
  });
  return repairNos;
}

function getValidPONos() {
  const rows = getSheetData("PurchaseOrders") || [];
  const poNos = new Set();
  rows.forEach(r => {
    const poNo = String(r[0] || '').trim();
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
  return data.slice(1); // Return raw rows excluding headers row
}

function postToSupabase(table, payload) {
  if (!payload || payload.length === 0) {
    Logger.log(`Skipped empty migration payload for "${table}"`);
    return;
  }
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

// ── FILE MIGRATION HELPERS (DRIVE TO SUPABASE STORAGE) ──
function extractFileId(url) {
  if (!url) return null;
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

function uploadDriveFileToSupabase(fileId, bucket, destName) {
  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    const mimeType = blob.getContentType();
    
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${destName}`;
    const options = {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": mimeType,
        "x-upsert": "true" // Overwrite if exists
      },
      payload: bytes,
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(uploadUrl, options);
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${destName}`;
    } else {
      Logger.log(`⚠️ Warning: Failed to upload file ${fileId} to ${bucket}. Code: ${code}. Response: ${response.getContentText()}`);
      return null;
    }
  } catch (e) {
    Logger.log(`⚠️ Warning: Could not fetch file ${fileId} from Drive: ${e.message}`);
    return null;
  }
}

// ── TABLE MIGRATORS (INDEX-BASED COLUMN MAPPING) ──

function migrateSettings() {
  const rows = getSheetData("Settings") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    key: String(r[0] || ''),
    value: String(r[1] || '')
  })).filter(r => r.key);
  
  postToSupabase("settings", payload);
}

function migrateBuses() {
  const rows = getSheetData("Buses") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    plate: String(r[0] || '').trim(),
    chassis: String(r[1] || ''),
    model: String(r[2] || ''),
    year: String(r[3] || ''),
    color: String(r[4] || ''),
    engine_no: String(r[5] || ''),
    last_inspect: r[6] instanceof Date ? Utilities.formatDate(r[6], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    reg_expiry: r[7] instanceof Date ? Utilities.formatDate(r[7], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    insurance_expiry: r[8] instanceof Date ? Utilities.formatDate(r[8], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    note: String(r[9] || '')
  })).filter(r => r.plate);
  
  postToSupabase("buses", payload);
}

function migrateShops() {
  const rows = getSheetData("Shops") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    id: String(r[0] || ''),
    name: String(r[1] || ''),
    address: String(r[2] || ''),
    tax_id: String(r[3] || ''),
    phone: String(r[4] || ''),
    note: String(r[5] || '')
  })).filter(r => r.id && r.name);
  
  postToSupabase("shops", payload);
}

function migrateStock() {
  const rows = getSheetData("Stock") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => ({
    id: String(r[0] || ''),
    part_code: String(r[1] || ''),
    part_name: String(r[2] || ''),
    unit: String(r[3] || 'ชิ้น'),
    qty: parseFloat(r[4]) || 0,
    min_qty: parseFloat(r[5]) || 0,
    location: String(r[6] || ''),
    note: String(r[7] || '')
  })).filter(r => r.id && r.part_name);
  
  postToSupabase("stock", payload);
}

function migrateProfiles() {
  const rows = getSheetData("Users") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const username = String(r[1] || '').trim();
    let signatureUrl = String(r[7] || '');
    
    // Auto-migrate signature from Google Drive to Supabase Storage
    if (signatureUrl.includes('drive.google.com') || signatureUrl.includes('docs.google.com')) {
      const fileId = extractFileId(signatureUrl);
      if (fileId) {
        Logger.log(`Migrating signature file from Drive for user "${username}"...`);
        const newUrl = uploadDriveFileToSupabase(fileId, "signatures", `sig-${username}.png`);
        if (newUrl) {
          signatureUrl = newUrl;
          Logger.log(`✅ Signature migrated successfully: ${newUrl}`);
        }
      }
    }
    
    return {
      id: String(r[0] || ''),
      username: username,
      password: String(r[2] || ''),
      name: String(r[3] || ''),
      status: String(r[4] || 'active'),
      role: String(r[5] || 'user'),
      line_user_id: String(r[6] || ''),
      signature_url: signatureUrl
    };
  }).filter(r => r.id && r.username);
  
  postToSupabase("profiles", payload);
}

function migrateRepairs(validPlates) {
  const rows = getSheetData("Repairs") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rawPlate = String(r[2] || '').trim();
    const plate = validPlates.has(rawPlate) ? rawPlate : null;
    return {
      repair_no: String(r[0] || ''),
      date: r[1] instanceof Date ? Utilities.formatDate(r[1], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      plate: plate,
      chassis: String(r[3] || ''),
      mileage: parseInt(r[4]) || 0,
      oil_program: String(r[5] || ''),
      repair_list: String(r[6] || ''),
      repair_summary: String(r[7] || ''),
      status: String(r[8] || 'รอดำเนินการ'),
      created_by: String(r[9] || ''),
      created_at: r[10] instanceof Date ? r[10].toISOString() : null,
      approved_by: String(r[11] || ''),
      approved_at: String(r[12] || '')
    };
  }).filter(r => r.repair_no);
  
  postToSupabase("repairs", payload);
}

function migrateRepairParts(validRepairNos) {
  const rows = getSheetData("RepairParts") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rNo = String(r[0] || '').trim();
    return {
      repair_no: rNo,
      part_name: String(r[2] || ''),
      qty: parseFloat(r[3]) || 1
    };
  }).filter(r => r.repair_no && r.part_name && validRepairNos.has(r.repair_no));
  
  postToSupabase("repair_parts", payload);
}

function migratePurchaseOrders(validRepairNos, validPlates) {
  const rows = getSheetData("PurchaseOrders") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const poNo = String(r[0] || '').trim();
    const rawRepNo = String(r[6] || '').trim();
    const refRepairNo = validRepairNos.has(rawRepNo) ? rawRepNo : null;
    const rawPlate = String(r[8] || '').trim();
    const plate = validPlates.has(rawPlate) ? rawPlate : null;
    
    let pdfUrl = String(r[17] || '');
    // Auto-migrate PDF from Google Drive to Supabase Storage
    if (pdfUrl.includes('drive.google.com') || pdfUrl.includes('docs.google.com')) {
      const fileId = extractFileId(pdfUrl);
      if (fileId) {
        Logger.log(`Migrating PDF file from Drive for PO "${poNo}"...`);
        const newUrl = uploadDriveFileToSupabase(fileId, "pdf-orders", `po-${poNo}.pdf`);
        if (newUrl) {
          pdfUrl = newUrl;
          Logger.log(`✅ PDF migrated successfully: ${newUrl}`);
        }
      }
    }
    
    let createdBySigUrl = String(r[13] || '');
    // Auto-migrate historical PO creator signature from Google Drive to Supabase Storage
    if (createdBySigUrl.includes('drive.google.com') || createdBySigUrl.includes('docs.google.com')) {
      const fileId = extractFileId(createdBySigUrl);
      if (fileId) {
        Logger.log(`Migrating creator signature file from Drive for PO "${poNo}"...`);
        const newUrl = uploadDriveFileToSupabase(fileId, "signatures", `sig-po-${poNo}.png`);
        if (newUrl) {
          createdBySigUrl = newUrl;
        }
      }
    }

    return {
      po_no: poNo,
      shop_name: String(r[1] || ''),
      shop_address: String(r[2] || ''),
      tax_id: String(r[3] || ''),
      issue_date: r[4] instanceof Date ? Utilities.formatDate(r[4], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      quote_date: r[5] instanceof Date ? Utilities.formatDate(r[5], Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
      ref_repair_no: refRepairNo,
      quote_no: String(r[7] || ''),
      plate: plate,
      vat_type: String(r[9] || 'none'),
      status: String(r[10] || 'รออนุมัติ'),
      created_by: String(r[11] || ''),
      created_at: r[12] instanceof Date ? r[12].toISOString() : null,
      created_by_signature_url: createdBySigUrl,
      approved_by: String(r[14] || ''),
      approved_at: String(r[15] || ''),
      line_sent_at: String(r[16] || ''),
      pdf_url: pdfUrl,
      grp_ref: String(r[18] || ''),
      quote_no_is_auto: r[19] === true || r[19] === 'TRUE',
      printed_at: String(r[20] || '')
    };
  }).filter(r => r.po_no);
  
  postToSupabase("purchase_orders", payload);
}

function migratePOItems(validPOs) {
  const rows = getSheetData("POItems") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const poNo = String(r[0] || '').trim();
    return {
      po_no: poNo,
      part_name: String(r[2] || ''),
      qty: parseFloat(r[3]) || 1,
      unit: String(r[4] || 'ชิ้น'),
      price_per_unit: parseFloat(r[5]) || 0,
      discount: parseFloat(r[6]) || 0,
      amount: parseFloat(r[7]) || 0,
      note: String(r[8] || '')
    };
  }).filter(r => r.po_no && r.part_name && validPOs.has(r.po_no));
  
  postToSupabase("po_items", payload);
}

function migrateOilTemplates(validPlates) {
  const rows = getSheetData("OilTemplates") || [];
  if (rows.length === 0) return;
  
  const payload = rows.map(r => {
    const rawPlate = String(r[0] || '').trim();
    return {
      plate: rawPlate,
      program: String(r[1] || ''),
      part_name: String(r[2] || ''),
      qty: parseFloat(r[3]) || 1,
      unit: String(r[4] || 'ชิ้น'),
      price_per_unit: parseFloat(r[5]) || 0
    };
  }).filter(r => r.plate && r.program && validPlates.has(r.plate));
  
  postToSupabase("oil_templates", payload);
}
