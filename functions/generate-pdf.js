const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
let supabase;
function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

exports.handler = async (event, context) => {
  initSupabase();
  const poNo = event.queryStringParameters.poNo;
  if (!poNo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing poNo parameter' }) };
  }

  try {
    // 1. Fetch PO data
    const { data: po, error: poErr } = await supabase.from('purchase_orders').select('*').eq('po_no', poNo).single();
    if (poErr || !po) {
      return { statusCode: 404, body: JSON.stringify({ error: 'PO not found: ' + (poErr?.message || '') }) };
    }

    // 2. Fetch PO Items
    const { data: items, error: itemsErr } = await supabase.from('po_items').select('*').eq('po_no', poNo);
    if (itemsErr) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch items' }) };
    }

    // 3. Fetch Settings
    const { data: settingsArr } = await supabase.from('settings').select('*');
    const settings = {};
    (settingsArr || []).forEach(s => { settings[s.key] = s.value; });

    // 4. Download Fonts dynamically to keep package size under 1MB
    const fontRegularBuffer = await fetchFont('https://fonts.gstatic.com/s/sarabun/v12/suls9Xr96xVnd02O0GT2JOk.ttf');
    const fontBoldBuffer = await fetchFont('https://fonts.gstatic.com/s/sarabun/v12/suls9Xr96xVnd02O0GT2Kek.ttf');

    // 5. Create PDF
    const pdfBuffer = await createPO_PDF(po, items || [], settings, fontRegularBuffer, fontBoldBuffer);

    // 6. Upload PDF to Supabase Storage
    const fileName = `PO_${poNo}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pdf-orders')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadErr) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload PDF: ' + uploadErr.message }) };
    }

    // 7. Get Public URL
    const { data: { publicUrl } } = supabase.storage
      .from('pdf-orders')
      .getPublicUrl(fileName);

    // 8. Update DB
    await supabase.from('purchase_orders').update({ pdf_url: publicUrl }).eq('po_no', poNo);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, pdfUrl: publicUrl })
    };

  } catch (err) {
    console.error('PDF Generation Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};

// Helper: Download font files into buffer
async function fetchFont(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch font: ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Draw the PDF PO layout
function createPO_PDF(po, items, settings, fontRegular, fontBold) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 30 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      // Register custom Sarabun fonts
      doc.registerFont('Sarabun', fontRegular);
      doc.registerFont('Sarabun-Bold', fontBold);
      doc.font('Sarabun');

      // Add logo image if exists in settings
      let logoBuffer = null;
      if (settings.COMPANY_LOGO) {
        try {
          const res = await fetch(settings.COMPANY_LOGO);
          if (res.ok) logoBuffer = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          console.warn('Failed to load logo image:', e);
        }
      }

      // Add stamp image if exists in settings
      let stampBuffer = null;
      if (settings.COMPANY_STAMP) {
        try {
          const res = await fetch(settings.COMPANY_STAMP);
          if (res.ok) stampBuffer = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          console.warn('Failed to load stamp image:', e);
        }
      }

      // Add signatures buffers
      let creatorSigBuffer = null;
      if (po.created_by_signature_url) {
        try {
          const res = await fetch(po.created_by_signature_url);
          if (res.ok) creatorSigBuffer = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          console.warn('Failed to load creator signature:', e);
        }
      }

      let approverSigBuffer = null;
      if (po.approved_by) {
        // Find approver profile to get signature url
        const { data: approverProf } = await supabase.from('profiles').select('signature_url').eq('name', po.approved_by).single();
        if (approverProf && approverProf.signature_url) {
          try {
            const res = await fetch(approverProf.signature_url);
            if (res.ok) approverSigBuffer = Buffer.from(await res.arrayBuffer());
          } catch (e) {
            console.warn('Failed to load approver signature:', e);
          }
        }
      }

      // Design PDF Layout parameters
      const totalPages = Math.ceil(items.length / 15) || 1;

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (pageNum > 1) doc.addPage();

        // ── TOP COMPANY HEADER BLOCK ──
        if (logoBuffer) {
          doc.image(logoBuffer, 30, 30, { width: 50, height: 50 });
        }
        
        doc.font('Sarabun-Bold').fontSize(12).fillColor('#10263d')
          .text(settings.COMPANY_NAME_EN || 'COMPANY NAME CO., LTD.', 90, 30);
        
        doc.font('Sarabun').fontSize(8).fillColor('#555555')
          .text(settings.COMPANY_ADDRESS_EN || '', 90, 45)
          .text(`Tel: ${settings.COMPANY_TEL || ''} | Fax: ${settings.COMPANY_FAX || ''}`, 90, 55)
          .text(`TAX ID: ${settings.COMPANY_TAX_ID || ''}`, 90, 65);

        doc.font('Sarabun-Bold').fontSize(10).fillColor('#10263d')
          .text(settings.COMPANY_NAME_TH || '', 90, 80);
        doc.font('Sarabun').fontSize(8).fillColor('#555555')
          .text(settings.COMPANY_ADDRESS_TH || '', 90, 92);

        // ── PO TITLE & NO BLOCK (Right Side) ──
        doc.rect(400, 30, 165, 30).fill('#10263d');
        doc.font('Sarabun-Bold').fontSize(12).fillColor('#ffffff')
          .text('ใบสั่งซื้อ / PURCHASE ORDER', 410, 38, { width: 145, align: 'center' });

        doc.font('Sarabun').fontSize(8).fillColor('#333333');
        doc.text('เลขที่ / PO No:', 400, 70, { width: 70, align: 'right' });
        doc.font('Sarabun-Bold').text(po.po_no, 480, 70);

        doc.font('Sarabun').text('วันที่ / Date:', 400, 82, { width: 70, align: 'right' });
        doc.text(po.issue_date, 480, 82);

        doc.font('Sarabun').text('หน้า / Page:', 400, 94, { width: 70, align: 'right' });
        doc.text(`${pageNum} / ${totalPages}`, 480, 94);

        // Underline header
        doc.strokeColor('#10263d').lineWidth(2).moveTo(30, 115).lineTo(565, 115).stroke();

        // ── VENDOR & DETAILS BLOCK ──
        doc.font('Sarabun-Bold').fontSize(9).fillColor('#10263d').text('ข้อมูลผู้ขาย / VENDOR', 30, 125);
        doc.font('Sarabun').fontSize(8).fillColor('#333333');
        doc.text(`ผู้ขาย: ${po.shop_name}`, 30, 137);
        doc.text(`ที่อยู่: ${po.shop_address || '-'}`, 30, 147, { width: 250 });
        doc.text(`เลขผู้เสียภาษี: ${po.tax_id || '-'}`, 30, 167);

        doc.font('Sarabun-Bold').fontSize(9).fillColor('#10263d').text('รายละเอียดสินค้า / DETAILS', 300, 125);
        doc.font('Sarabun').fontSize(8).fillColor('#333333');
        doc.text(`ทะเบียนรถ: ${po.plate || '-'}`, 300, 137);
        doc.text(`อ้างอิงใบแจ้งซ่อม: ${po.ref_repair_no || '-'}`, 300, 147);
        doc.text(`เลขที่ใบเสนอราคา: ${po.quote_no || '-'}`, 300, 157);

        // ── TABLE GRID FOR ITEMS ──
        const tableTop = 185;
        doc.rect(30, tableTop, 535, 20).fill('#10263d');
        doc.font('Sarabun-Bold').fontSize(8).fillColor('#ffffff');
        doc.text('ลำดับ', 32, tableTop + 6, { width: 30, align: 'center' });
        doc.text('รายการสินค้า / Description', 65, tableTop + 6, { width: 230 });
        doc.text('จำนวน', 300, tableTop + 6, { width: 40, align: 'right' });
        doc.text('หน่วย', 345, tableTop + 6, { width: 35, align: 'center' });
        doc.text('ราคา/หน่วย', 385, tableTop + 6, { width: 55, align: 'right' });
        doc.text('ส่วนลด', 445, tableTop + 6, { width: 45, align: 'right' });
        doc.text('จำนวนเงิน', 495, tableTop + 6, { width: 65, align: 'right' });

        // Draw rows
        const startItemIdx = (pageNum - 1) * 15;
        const pageItems = items.slice(startItemIdx, startItemIdx + 15);
        let y = tableTop + 20;

        doc.font('Sarabun').fontSize(8).fillColor('#333333');
        pageItems.forEach((item, index) => {
          const rowIdx = startItemIdx + index + 1;
          const itemText = item.note ? `${item.part_name} (${item.note})` : item.part_name;
          doc.text(rowIdx.toString(), 32, y + 5, { width: 30, align: 'center' });
          doc.text(itemText, 65, y + 5, { width: 230, height: 12, ellipsis: true });
          doc.text(Number(item.qty).toString(), 300, y + 5, { width: 40, align: 'right' });
          doc.text(item.unit || 'ชิ้น', 345, y + 5, { width: 35, align: 'center' });
          doc.text(formatMoney(item.price_per_unit), 385, y + 5, { width: 55, align: 'right' });
          doc.text(formatMoney(item.discount), 445, y + 5, { width: 45, align: 'right' });
          doc.text(formatMoney(item.amount), 495, y + 5, { width: 65, align: 'right' });
          
          doc.strokeColor('#dddddd').lineWidth(0.5).moveTo(30, y + 18).lineTo(565, y + 18).stroke();
          y += 18;
        });

        // Fill empty rows to make the table look uniform
        const remainingRows = 15 - pageItems.length;
        for (let r = 0; r < remainingRows; r++) {
          doc.strokeColor('#eeeeee').lineWidth(0.5).moveTo(30, y + 18).lineTo(565, y + 18).stroke();
          y += 18;
        }

        // Draw outer borders of table
        doc.strokeColor('#10263d').lineWidth(1).rect(30, tableTop, 535, 290).stroke();

        // ── NOTES & TOTALS SECTION (Only on last page) ──
        if (pageNum === totalPages) {
          const summaryTop = y + 10;
          doc.font('Sarabun-Bold').fontSize(8).fillColor('#10263d').text('หมายเหตุ:', 35, summaryTop);
          doc.font('Sarabun').fontSize(8).fillColor('#555555')
            .text('1. โปรดส่งของให้ตรงตามกำหนดเวลา หากช้ากว่ากำหนดจะถูกปรับตามข้อตกลง', 35, summaryTop + 12)
            .text('2. เอกสารฉบับนี้มีผลสมบูรณ์เมื่อผู้มีอำนาจลงนามอนุมัติครบถ้วน', 35, summaryTop + 22);

          // Calculate summary values
          const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
          let vat = 0;
          let grandTotal = subtotal;

          if (po.vat_type === 'exclusive') {
            vat = subtotal * 0.07;
            grandTotal = subtotal + vat;
          } else if (po.vat_type === 'inclusive') {
            vat = subtotal - (subtotal / 1.07);
          }
          const beforeVat = po.vat_type === 'inclusive' ? subtotal / 1.07 : subtotal;

          // Totals display
          doc.font('Sarabun').fillColor('#333333');
          doc.text('รวมเงินก่อนภาษี / Sub Total:', 350, summaryTop, { width: 130, align: 'right' });
          doc.text(formatMoney(beforeVat), 490, summaryTop, { width: 75, align: 'right' });

          doc.text('ภาษีมูลค่าเพิ่ม / VAT 7%:', 350, summaryTop + 12, { width: 130, align: 'right' });
          doc.text(formatMoney(vat), 490, summaryTop + 12, { width: 75, align: 'right' });

          doc.rect(350, summaryTop + 24, 215, 18).fill('#10263d');
          doc.font('Sarabun-Bold').fillColor('#ffffff');
          doc.text('ยอดเงินสุทธิ / Grand Total:', 355, summaryTop + 29, { width: 125 });
          doc.text(formatMoney(grandTotal), 490, summaryTop + 29, { width: 70, align: 'right' });

          // ── SIGNATURES BLOCK ──
          const sigTop = summaryTop + 50;

          // Prepared By
          doc.strokeColor('#cccccc').rect(30, sigTop, 160, 80).stroke();
          doc.font('Sarabun-Bold').fillColor('#10263d').text('ผู้จัดทำ / Prepared By', 35, sigTop + 6, { width: 150, align: 'center' });
          if (creatorSigBuffer) doc.image(creatorSigBuffer, 65, sigTop + 20, { height: 35 });
          doc.font('Sarabun').fillColor('#666666').text(`( ${po.created_by || '..........................'} )`, 30, sigTop + 60, { width: 160, align: 'center' });

          // Approved By
          doc.strokeColor('#cccccc').rect(215, sigTop, 160, 80).stroke();
          doc.font('Sarabun-Bold').fillColor('#10263d').text('ผู้อนุมัติ / Approved By', 220, sigTop + 6, { width: 150, align: 'center' });
          if (approverSigBuffer) doc.image(approverSigBuffer, 250, sigTop + 20, { height: 35 });
          doc.font('Sarabun').fillColor('#666666').text(`( ${po.approved_by || '..........................'} )`, 215, sigTop + 60, { width: 160, align: 'center' });

          // Authorizer (Sign & Stamp)
          doc.strokeColor('#cccccc').rect(400, sigTop, 165, 80).stroke();
          doc.font('Sarabun-Bold').fillColor('#10263d').text('ผู้สั่งซื้อ / Authorizer', 405, sigTop + 6, { width: 155, align: 'center' });
          if (stampBuffer) doc.image(stampBuffer, 460, sigTop + 20, { height: 35 });
          doc.font('Sarabun').fillColor('#666666').text('( บริษัท มุ่งคงทัวร์บัส จำกัด )', 400, sigTop + 60, { width: 165, align: 'center' });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function formatMoney(value) {
  const num = parseFloat(value) || 0;
  return num.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
