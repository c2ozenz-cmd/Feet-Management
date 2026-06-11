// ============================================================
// PDF.gs — Generate PO PDF and save to Google Drive
// ============================================================

function testGeneratePDF() {
  const result = generateAndSavePOPdf('PO26050013');
  Logger.log(JSON.stringify(result));
}

function fmtNum(n) {
  return parseFloat(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '-';
  try {
    const dt = new Date(d);
    return (
      String(dt.getDate()).padStart(2, '0') + '/' +
      String(dt.getMonth() + 1).padStart(2, '0') + '/' +
      (dt.getFullYear() + 543)
    );
  } catch (e) {
    return String(d);
  }
}

function imageUrlToBase64(url) {
  if (!url) return '';
  try {
    const fileIdMatch = String(url).match(/\/d\/([-\w]+)/) ||
                        String(url).match(/[?&]id=([-\w]+)/);

    if (fileIdMatch) {
      const fileId = fileIdMatch[1];
      Logger.log('imageUrlToBase64 Drive fileId: ' + fileId);
      const blob = DriveApp.getFileById(fileId).getBlob();
      const base64 = Utilities.base64Encode(blob.getBytes());
      const contentType = blob.getContentType() || 'image/png';
      return `data:${contentType};base64,${base64}`;
    }

    const fetchUrl = convertDriveUrlForPdf(url);
    Logger.log('imageUrlToBase64 fetching: ' + fetchUrl);

    const response = UrlFetchApp.fetch(fetchUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const code = response.getResponseCode();
    Logger.log('imageUrlToBase64 response code: ' + code);

    if (code !== 200) {
      Logger.log('imageUrlToBase64 failed, code=' + code);
      return '';
    }

    const blob = response.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());
    const contentType = blob.getContentType();
    return `data:${contentType};base64,${base64}`;
  } catch (e) {
    Logger.log('imageUrlToBase64 error: ' + e);
    return '';
  }
}

// ── แปลง Drive URL สำหรับ PDF.gs (ใช้ uc?export=view แทน thumbnail) ──
function convertDriveUrlForPdf(url) {
  if (!url) return '';
  const match = url.match(/\/d\/([-\w]+)/) ||
                url.match(/id=([-\w]+)/);
  if (match) {
    // ใช้ export=view เพราะ thumbnail บางครั้ง UrlFetchApp โหลดไม่ได้
    return 'https://drive.google.com/uc?export=view&id=' + match[1];
  }
  return url;
}

// ── ดึง Font จาก Google Fonts แล้ว embed เป็น base64 ──
function fetchGoogleFontAsBase64() {
  try {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap';
    const cssRes = UrlFetchApp.fetch(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    let css = cssRes.getContentText();

    const urlMatches = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g) || [];

    urlMatches.forEach(match => {
      const fontUrl = match.replace(/url\(|\)/g, '');
      try {
        const fontBlob = UrlFetchApp.fetch(fontUrl).getBlob();
        const base64   = Utilities.base64Encode(fontBlob.getBytes());
        const mimeType = fontBlob.getContentType();
        css = css.replace(fontUrl, `data:${mimeType};base64,${base64}`);
      } catch (e) {
        Logger.log('Font fetch error: ' + e.message);
      }
    });

    return css;

  } catch (e) {
    Logger.log('fetchGoogleFontAsBase64 error: ' + e.message);
    return "* { font-family: 'TH Sarabun New', Arial, sans-serif !important; }";
  }
}

// ── Generate PDF และบันทึกลง Google Drive ──
function generateAndSavePOPdf(poNo) {
  try {

    const ss        = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet   = ss.getSheetByName('PurchaseOrders');
    const itemSheet = ss.getSheetByName('POItems');
    const settingArr = getAllSettings();

    if (!poSheet) {
      return { success: false, message: 'ไม่พบชีท PurchaseOrders' };
    }

    const poHeaders = ensurePOColumns();

    // ── โหลดข้อมูล PO ──
    const poData     = poSheet.getDataRange().getValues();
    const poNoColIdx = poHeaders.indexOf('PONo');
    const poRow = poData.find((r, i) =>
      i > 0 && String(r[poNoColIdx]).trim() === String(poNo).trim()
    );

    if (!poRow) {
      return { success: false, message: `ไม่พบ PO: ${poNo}` };
    }

    const poRaw = {};
    poHeaders.forEach((h, i) => poRaw[h] = poRow[i]);

    const po = {
      poNo        : poRaw['PONo']        || '',
      shopName    : poRaw['ShopName']    || '',
      shopAddress : poRaw['ShopAddress'] || '',
      taxId       : poRaw['TaxID']       || '',
      issueDate   : poRaw['IssueDate']   || '',
      quoteDate   : poRaw['QuoteDate']   || '',
      quoteNo     : poRaw['QuoteNo']     || '',
      refRepairNo : poRaw['RefRepairNo'] || '',
      plate       : poRaw['Plate']       || '',
      vatType     : poRaw['VatType']     || 'none',
      createdBy   : poRaw['CreatedBy']   || '',
      createdBySignatureUrl: poRaw['createdBySignatureUrl'] || getUserSignatureByName(poRaw['CreatedBy'] || '')
    };

    const approvedBy = String(poRaw['approvedBy'] || '');
    const rawSigUrl = approvedBy ? getApproverSignature(approvedBy) : '';
    const sigUrl    = rawSigUrl ? convertDriveUrlForPdf(rawSigUrl) : '';

    // ── โหลดรายการสินค้า ──
    let items = [];

    if (itemSheet) {
      const itemData    = itemSheet.getDataRange().getValues();
      const itemHeaders = itemData[0];
      const itemPoNoIdx = itemHeaders.findIndex(h => h.toLowerCase() === 'pono');

    items = itemData.slice(1)
      .filter(r => String(r[itemPoNoIdx]).trim() === String(poNo).trim())
      .map(r => {
        const obj = {};
        itemHeaders.forEach((h, i) => obj[h.toLowerCase()] = r[i]);
        return {
          partName     : obj['partname']     || '',
          qty          : obj['qty']          || 0,
          unit         : obj['unit']         || '',
          pricePerUnit : obj['priceperunit'] || 0,
          discount     : obj['discount']     || 0,
          amount       : obj['amount']       || 0,
          note         : obj['note']         || ''   // ✅ เพิ่มบรรทัดนี้
        };
      });
    }

    // ── โหลด settings ──
    const s = {};
    (settingArr || []).forEach(x => { s[x.key] = x.value; });

    // ── ดึง Font ก่อน build HTML ──
    Logger.log('Fetching Google Font...');
    const fontCss = fetchGoogleFontAsBase64();
    Logger.log('Font fetched, length: ' + fontCss.length);

    // ── สร้าง HTML ──
    const htmlContent = buildPOHtmlForPdf(po, items, s, fontCss, approvedBy, sigUrl);

    // ── HTML → PDF ──
    const htmlBlob = Utilities.newBlob(
      htmlContent,
      'text/html',
      `PO_${po.poNo}.html`
    );

    const tempHtmlFile = DriveApp.createFile(htmlBlob);

    const pdfBlob = tempHtmlFile
      .getAs(MimeType.PDF)
      .setName(`PO_${po.poNo}.pdf`);

    tempHtmlFile.setTrashed(true);

    // ── บันทึก PDF ลง Folder ──
    const folderId = s['DRIVE_PDF_FOLDER_ID'] || '';

    if (!folderId) {
      return { success: false, message: 'ยังไม่ได้ตั้งค่า DRIVE_PDF_FOLDER_ID' };
    }

    const folder = DriveApp.getFolderById(folderId);

    // ลบไฟล์เก่า
    const existing = folder.getFilesByName(`PO_${po.poNo}.pdf`);
    while (existing.hasNext()) {
      existing.next().setTrashed(true);
    }

    const pdfFile = folder.createFile(pdfBlob);
    const pdfUrl  = pdfFile.getUrl();

    Logger.log('PDF URL: ' + pdfUrl);

    // ── บันทึก URL ลงชีท ──
    const pdfColIdx = poHeaders.indexOf('pdfUrl');
    const rowIdx    = poData.findIndex((r, i) =>
      i > 0 && String(r[poNoColIdx]).trim() === String(poNo).trim()
    );

    if (pdfColIdx >= 0 && rowIdx > 0) {
      poSheet.getRange(rowIdx + 1, pdfColIdx + 1).setValue(pdfUrl);
    }

    return { success: true, pdfUrl };

  } catch (e) {
    Logger.log('generateAndSavePOPdf error: ' + e.message + '\n' + e.stack);
    return { success: false, message: e.message };
  }
}

// ── สร้าง HTML สำหรับแปลงเป็น PDF ──
function buildPOHtmlForPdf(po, items, settingsArr, fontCss, approvedBy, sigUrl) {

  const s        = Array.isArray(settingsArr) ? _settingsToObj(settingsArr) : (settingsArr || {});
  const vatType  = po.vatType || 'none';
  const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);

  let vat = 0, grand = subtotal;
  if (vatType === 'exclusive') { vat = subtotal * 0.07; grand = subtotal + vat; }
  else if (vatType === 'inclusive') { vat = subtotal - subtotal / 1.07; grand = subtotal; }
  const preVat = vatType === 'inclusive' ? subtotal / 1.07 : subtotal;

  const logoBase64  = s.COMPANY_LOGO  ? imageUrlToBase64(s.COMPANY_LOGO)  : '';
  const stampBase64 = s.COMPANY_STAMP ? imageUrlToBase64(s.COMPANY_STAMP) : '';

  const logoHtml = logoBase64
    ? `<img src="${logoBase64}" style="width:120px;height:120px;object-fit:contain;border-radius:50%;border:2px solid rgba(255,255,255,0.4)">`
    : `<div style="width:120px;height:120px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;color:#10263d;text-align:center;font-weight:700">LOGO<br>บริษัท</div>`;

const stampHtml = stampBase64
  ? ` <img 
      src="${stampBase64}" 
      style=" max-width:65px; max-height:45px; object-fit:contain; opacity:0.88;display:block; "> ` : ` 
    <div style=" width:65px; height:45px; border:1px dashed #ccc; border-radius:4px;display:flex; align-items:center; justify-content:center; font-size:9px;color:#bbb; text-align:center; background:#fafafa; line-height:1.2; ">ตรา<br>ประทับ </div> `;

  const ROWS_FIRST_PAGE = 15;
  const ROWS_OTHER_PAGE = 17;
  const chunks = [];
    if (items.length > 0) {
    chunks.push(items.slice(0, ROWS_FIRST_PAGE));
  }
    let i = ROWS_FIRST_PAGE;
  while (i < items.length) {
    chunks.push(items.slice(i, i + ROWS_OTHER_PAGE));
    i += ROWS_OTHER_PAGE;
  }
  if (chunks.length === 0) chunks.push([]);


  const totalPages = chunks.length;

  function renderHeader(pageNum) {
    return `
    <div style="display:flex;align-items:stretch;border-bottom:3px solid #10263d">
      <div style="width:110px;display:flex;align-items:center;justify-content:center;padding:14px;flex-shrink:0">
        ${logoHtml}
      </div>
      <div style="flex:1;padding:12px 16px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <div style="font-size:15px;font-weight:700;color:#10263d">${s.COMPANY_NAME_EN || 'COMPANY NAME CO., LTD.'}</div>
          <div style="font-size:11px;color:#555;margin-top:2px">${s.COMPANY_ADDRESS_EN || ''}</div>
          <div style="font-size:11px;color:#555">Tel: ${s.COMPANY_TEL || ''} &nbsp;|&nbsp; Fax: ${s.COMPANY_FAX || ''}</div>
          <div style="font-size:11px;color:#555">TAX ID: ${s.COMPANY_TAX_ID || ''}</div>
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd">
            <div style="font-size:12px;font-weight:700;color:#10263d">${s.COMPANY_NAME_TH || ''}</div>
            <div style="font-size:11px;color:#555">${s.COMPANY_ADDRESS_TH || ''}</div>
            <div style="font-size:11px;color:#555">โทร: ${s.COMPANY_TEL || ''} &nbsp;|&nbsp; แฟกซ์: ${s.COMPANY_FAX || ''}</div>
          </div>
        </div>
        <div style="text-align:right;min-width:180px;flex-shrink:0">
          <div style="background-color:#10263d !important;color:#ffffff !important;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;padding:6px 14px;text-align:center;margin-bottom:8px">
            <div style="font-size:15px;font-weight:700;letter-spacing:2px">ใบสั่งซื้อ</div>
            <div style="font-size:10px;letter-spacing:3px;opacity:0.85">PURCHASE ORDER</div>
          </div>
          <table style="width:100%;font-size:11px;border-collapse:collapse">
            <tr>
              <td style="text-align:right;padding:2px 6px 2px 0;color:#555">เลขที่ :</td>
              <td style="border-bottom:1px solid #000;text-align:center;font-weight:700;padding:2px 4px">${po.poNo}</td>
            </tr>
            <tr>
              <td style="text-align:right;padding:2px 6px 2px 0;color:#555">วันที่ :</td>
              <td style="border-bottom:1px solid #000;text-align:center;padding:2px 4px">${formatDate(po.issueDate)}</td>
            </tr>
            <tr>
              <td style="text-align:right;padding:2px 6px 2px 0;color:#555">หน้า :</td>
              <td style="border-bottom:1px solid #000;text-align:center;padding:2px 4px">${pageNum} / ${totalPages}</td>
            </tr>
          </table>
        </div>
      </div>
    </div>`;
  }

  function renderSupplier() {
    return `
    <div style="display:flex;border-bottom:1px solid #ccc;font-size:11px">
      <div style="flex:1;padding:10px 14px;border-right:1px solid #ccc">
        <div style="font-size:10px;font-weight:700;color:#10263d;letter-spacing:0.5px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e8e8e8">ข้อมูลผู้ขาย / VENDOR</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#444;width:85px;padding:2px 0">ชื่อผู้ขาย</td><td style="font-weight:600;border-bottom:1px solid #ddd;padding:2px 4px">${po.shopName || ''}</td></tr>
          <tr><td style="color:#444;padding:2px 0;vertical-align:top">ที่อยู่</td><td style="border-bottom:1px solid #ddd;padding:2px 4px">${po.shopAddress || ''}</td></tr>
          <tr><td style="color:#444;padding:2px 0">เลขผู้เสียภาษี</td><td style="border-bottom:1px solid #ddd;padding:2px 4px">${po.taxId || ''}</td></tr>
        </table>
      </div>
      <div style="width:220px;padding:10px 14px;flex-shrink:0">
        <div style="font-size:10px;font-weight:700;color:#10263d;letter-spacing:0.5px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e8e8e8">อ้างอิงใบเสนอราคา</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#444;padding:2px 0;width:85px">เลขที่ใบเสนอ</td><td style="border-bottom:1px solid #ddd;padding:2px 4px">${po.quoteNo || ''}</td></tr>
          <tr><td style="color:#444;padding:2px 0">วันที่ใบเสนอ</td><td style="border-bottom:1px solid #ddd;padding:2px 4px">${po.quoteDate ? formatDate(po.quoteDate) : ''}</td></tr>
          <tr><td style="color:#444;padding:2px 0">กำหนดส่ง</td><td style="border-bottom:1px solid #ddd;padding:2px 4px"></td></tr>
        </table>
      </div>
    </div>`;
  }

  function renderTableHeader() {
    return `
    <div style="background:#f0f4f8;border-bottom:1px solid #ccc;padding:5px 14px;font-size:11px;font-weight:700;color:#10263d;text-align:center;letter-spacing:0.5px">
      กรุณาจำหน่ายสินค้าตามรายการดังต่อไปนี้
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr style="background-color:#10263d !important;color:#ffffff !important;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;">
          <th style="padding:4px 8px;width:32px;text-align:center;font-weight:600">ลำดับ</th>
          <th style="padding:4px 8px;text-align:left;font-weight:600">รายละเอียด / สินค้า</th>
          <th style="padding:4px 8px;width:50px;text-align:center;font-weight:600">จำนวน</th>
          <th style="padding:4px 8px;width:45px;text-align:center;font-weight:600">หน่วย</th>
          <th style="padding:4px 8px;width:75px;text-align:center;font-weight:600">ราคา/หน่วย</th>
          <th style="padding:4px 8px;width:60px;text-align:center;font-weight:600">ส่วนลด</th>
          <th style="padding:4px 8px;width:80px;text-align:center;font-weight:600">จำนวนเงิน</th>
        </tr>
      </thead>`;
  }

  function renderNotes(items) {
    const noted = items
      .map((it, i) => it.note ? { idx: i + 1, name: it.partName, note: it.note } : null)
      .filter(Boolean);
    if (!noted.length) return '';
    return `
    <div style="border-top:1px dashed #ccc;padding:6px 14px 4px;font-size:11px">
      <span style="font-weight:700;color:#10263d">หมายเหตุรายการ : </span>
      ${noted.map(n => `<span style="margin-right:12px">รายการที่ ${n.idx} ${n.note}</span>`).join(',')}
    </div>`;
  }

function renderRows(chunk, startIdx) {
  const MIN_ROWS = 5;
  const rows     = [...chunk];
  const padTo    = Math.max(rows.length, MIN_ROWS);
  while (rows.length < padTo) rows.push(null);

  return rows.map((it, i) => {
    const globalIdx = startIdx + i;
    const bg        = globalIdx % 2 === 0 ? '#fff' : '#f9fafb';
    return `
    <tr style="background:${bg};border-bottom:1px solid #eee">
      <td style="padding:2px 6px;text-align:center;color:#aaa">${it ? globalIdx + 1 : ''}</td>
      <td style="padding:2px 6px">${it ? it.partName : ''}</td>
      <td style="padding:2px 6px;text-align:center">${it ? it.qty : ''}</td>
      <td style="padding:2px 6px;text-align:center;color:#888">${it ? (it.unit || '') : ''}</td>
      <td style="padding:2px 6px;text-align:right">${it ? fmtNum(it.pricePerUnit) : ''}</td>
      <td style="padding:2px 6px;text-align:right;color:#c05050">${it && parseFloat(it.discount) > 0 ? fmtNum(it.discount) : (it ? '-' : '')}</td>
      <td style="padding:2px 6px;text-align:right;font-weight:600">${it ? fmtNum(it.amount) : ''}</td>
    </tr>`;
  }).join('');
}


  const sigBase64 = sigUrl ? imageUrlToBase64(sigUrl) : '';

  const sigBoxes = [
    { role: 'ผู้ขอ',           name: po.createdBy || '', img: po.createdBySignatureUrl || getUserSignatureByName(po.createdBy || ''), stamp: false, issueDate: po.issueDate || '' },
    { role: 'ผู้อนุมัติ',       name: approvedBy   || '', img: sigBase64, stamp: false },
    { role: 'ผู้มีอำนาจลงนาม', name: '',                 img: '',        stamp: true  }
  ];

  // ── ใหม่ (ถูก) ──
  const sigHtml = sigBoxes.map((box, i) => {

    const imgSrc = box.img || '';

    const imgHtml = box.stamp
      ? stampHtml
      : imgSrc
        ? `<img src="${imgSrc}" style="max-height:45px;max-width:120px;object-fit:contain">`
        : `<div style="height:45px"></div>`;

    // ชื่อต้องเป็น string ชื่อจริงเท่านั้น ไม่ใช่ URL
    const displayName = (box.name && !box.name.startsWith('http'))
      ? `( ${box.name} )`
      : '( ........................... )';

    return `
    <div style="flex:1;text-align:center;padding:0 10px;${i < 2 ? 'border-right:1px solid #eee' : ''}">
      <div style="height:50px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;margin-bottom:4px">
        ${imgHtml}
      </div>
      <div style="border-top:1px solid #000;padding-top:5px;font-size:11px;font-weight:700;color:#10263d">
        ${box.role}
      </div>
      <div style="font-size:11px;color:#444;min-height:16px">
        ${displayName}
      </div>
      <div style="font-size:11px;color:#444">วันที่ ${box.issueDate ? formatDate(box.issueDate) : '......../......../........'}</div>
    </div>`;
  }).join('');

  function renderFooter() {
    return `
    <div style="display:flex;border-top:2px solid #10263d">
      <div style="flex:1;padding:10px 14px;border-right:1px solid #ccc;font-size:11px">
        <div style="display:flex;align-items:center;gap:6px;padding-bottom:6px;border-bottom:1px solid #ddd;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-weight:700;color:#10263d">หมายเหตุ :</span>
          ${po.plate ? `<span style="background:#ffd600;color:#5a3e00;padding:1px 10px;font-weight:700">${po.plate}</span>` : ''}
          ${po.refRepairNo ? `<span style="background:#10263d;color:#fff;padding:1px 10px">Job: ${po.refRepairNo}</span>` : ''}
        </div>
        <div style="color:#444;line-height:1.5">
          (1) โปรดระบุเลขที่ใบสั่งซื้อบนใบส่งของทุกฉบับ<br>
          (2) การวางบิลและรับเช็คเป็นไปตามกำหนดเวลาที่บริษัทกำหนด<br>
          (3) ในการวางบิลให้แนบสำเนาใบสั่งซื้อกำกับด้วย
        </div>
      </div>
      <div style="width:220px;font-size:11px;flex-shrink:0">
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:5px 12px;color:#555">มูลค่าสินค้าก่อนภาษี</td>
            <td style="padding:5px 12px;text-align:right">${fmtNum(preVat)}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:5px 12px;color:#555">ส่วนลดสินค้า</td>
            <td style="padding:5px 12px;text-align:right">0.00</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:5px 12px;color:#555">เงินหลังหักส่วนลด</td>
            <td style="padding:5px 12px;text-align:right">${fmtNum(preVat)}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:5px 12px;color:#555">ภาษีมูลค่าเพิ่ม (7%)</td>
            <td style="padding:5px 12px;text-align:right">${vatType !== 'none' ? fmtNum(vat) : '0.00'}</td>
          </tr>
          <tr style="background-color:#10263d !important;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;">
            <td style="padding:7px 12px;color:#fff;font-weight:700">จำนวนเงินทั้งสิ้น</td>
            <td style="padding:7px 12px;text-align:right;color:#fff;font-weight:700">${fmtNum(grand)}</td>
          </tr>
        </table>
      </div>
    </div>
    <div style="display:flex;padding:8px 12px 8px;border-top:1px solid #eee">
      ${sigHtml}
    </div>`;
  }

  let runningIndex = 0;
  const pages = chunks.map((chunk, pageIdx) => {
    const isFirst   = pageIdx === 0;
    const isLast    = pageIdx === totalPages - 1;
    const startIdx  = runningIndex;
    runningIndex   += chunk.length;
    const pageBreak = !isLast ? 'page-break-after:always;' : '';

    return `
    <div style="background:#fff;max-width:780px;margin:0 auto;${pageBreak}">
      ${renderHeader(pageIdx + 1)}
      ${isFirst ? renderSupplier() : ''}
      ${renderTableHeader()}
        <tbody>${renderRows(chunk, startIdx)}</tbody>
      </table>
      ${isLast ? renderNotes(items) : ''}
      ${isLast ? renderFooter() : ''}
    </div>`;
  }).join('');

  // ── คืน HTML สมบูรณ์ ──
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>

${fontCss || "* { font-family: 'TH Sarabun New', Arial, sans-serif !important; }"}

body {
  margin: 0;
  padding: 20px;
  background: #fff;
  font-size: 13px;
  line-height: 1.6;
}

table {
  border-collapse: collapse;
  width: 100%;
}

tr {
  page-break-inside: avoid;
}

@page {
  size: A4;
  margin: 10mm;
}

* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  box-sizing: border-box;
  font-family: 'Sarabun', 'TH Sarabun New', Arial, sans-serif !important;
}

thead {
  display: table-header-group;
}

tfoot {
  display: table-footer-group;
}

</style>
</head>
<body>
<div id="poPrintDoc" style="font-family:'Sarabun','TH Sarabun New',Arial,sans-serif;font-size:13px;color:#000">
${pages}
</div>
</body>
</html>`;

}

function testPDFWithManyItems() {
  const po = {
    poNo: 'TEST001', shopName: 'ร้านทดสอบ',
    shopAddress: '123 ถนนทดสอบ', taxId: '1234567890123',
    issueDate: new Date(), quoteDate: new Date(),
    quoteNo: 'Q001', refRepairNo: 'REP001',
    plate: 'กข-1234', vatType: 'exclusive',
    createdBy: 'Admin'
  };

  // สร้าง 20 items ทดสอบ
  const items = Array.from({ length: 15 }, (_, i) => ({
    partName    : `อะไหล่รายการที่ ${i + 1}`,
    qty         : i + 1,
    unit        : 'ชิ้น',
    pricePerUnit: 1000,
    discount    : 0,
    amount      : 1000 * (i + 1)
  }));

  const s = {};
  getAllSettings().forEach(x => s[x.key] = x.value);

  const fontCss     = fetchGoogleFontAsBase64();
  const htmlContent = buildPOHtmlForPdf(po, items, s, fontCss, '', '');

  const blob     = Utilities.newBlob(htmlContent, 'text/html', 'test.html');
  const tempFile = DriveApp.createFile(blob);
  const pdfBlob  = tempFile.getAs(MimeType.PDF).setName('test_20items.pdf');
  tempFile.setTrashed(true);

  const folder  = DriveApp.getFolderById(s['DRIVE_PDF_FOLDER_ID']);
  const pdfFile = folder.createFile(pdfBlob);
  Logger.log('Test PDF: ' + pdfFile.getUrl());
}
