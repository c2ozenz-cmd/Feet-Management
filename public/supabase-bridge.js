// Supabase Compatibility Bridge for Google Apps Script (google.script.run)
// This file maps legacy google.script.run calls directly to Supabase client queries.

(function() {
  // Read config from meta tags or environment (Netlify injects these into window)
  const supabaseUrl = window.SUPABASE_URL || '';
  const supabaseAnonKey = window.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Supabase credentials not found. Make sure window.SUPABASE_URL and window.SUPABASE_ANON_KEY are set.');
  }

  // Initialize Supabase Client
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  window.supabaseClient = supabase; // Export globally

  // Bridge class to mimic google.script.run structure
  class ScriptRunBridge {
    constructor() {
      this.successCallback = null;
      this.failureCallback = null;
    }

    withSuccessHandler(callback) {
      this.successCallback = callback;
      return this;
    }

    withFailureHandler(callback) {
      this.failureCallback = callback;
      return this;
    }

    // Helper: Execute success callback
    _ok(data) {
      if (this.successCallback) this.successCallback(data);
    }

    // Helper: Execute failure callback
    _err(error) {
      console.error('Bridge error:', error);
      if (this.failureCallback) this.failureCallback(error);
      else if (window.showToast) window.showToast('error', error.message || String(error));
    }

    // ── AUTH / LOGIN ──
    async login(username, password) {
      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('username', username)
          .eq('password', password)
          .single();
        
        if (error || !profile) {
          throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        }

        if (profile.status !== 'active') {
          throw new Error('บัญชีนี้ถูกระงับการใช้งาน');
        }

        const user = {
          id: profile.id,
          username: profile.username,
          name: profile.name,
          status: profile.status,
          role: profile.role,
          lineUserId: profile.line_user_id,
          signatureUrl: profile.signature_url
        };

        window.currentUser = user; // Store globally for other operations

        this._ok({ success: true, user });
      } catch (err) {
        this._ok({ success: false, message: err.message });
      }
    }

    // ── COMPANY SETTINGS ──
    async getAllSettings() {
      try {
        const { data, error } = await supabase.from('settings').select('*');
        if (error) throw error;
        // Map settings rows to array of key-value objects
        const mapped = (data || []).map(s => ({ key: s.key, value: s.value }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveSettings(settingsObj) {
      try {
        const upserts = Object.keys(settingsObj).map(key => ({
          key: key,
          value: String(settingsObj[key])
        }));
        const { error } = await supabase.from('settings').upsert(upserts);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── USERS / PROFILES ──
    async getUsers() {
      try {
        const { data, error } = await supabase.from('profiles').select('*');
        if (error) throw error;
        const mapped = (data || []).map(p => ({
          id: p.id,
          username: p.username,
          name: p.name,
          status: p.status,
          role: p.role,
          lineUserId: p.line_user_id,
          signatureUrl: p.signature_url
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveUser(user) {
      try {
        const payload = {
          username: user.username,
          name: user.name,
          status: user.status || 'active',
          role: user.role || 'user',
          line_user_id: user.lineUserId || '',
          signature_url: user.signatureUrl || ''
        };
        
        // If password is provided, save it too
        if (user.password) {
          payload.password = user.password;
        }

        if (user.id) {
          const { error } = await supabase.from('profiles').update(payload).eq('id', user.id);
          if (error) throw error;
          this._ok({ success: true });
        } else {
          const id = 'U' + Date.now();
          const { error } = await supabase.from('profiles').insert({ id, ...payload });
          if (error) throw error;
          this._ok({ success: true, id });
        }
      } catch (err) { this._err(err); }
    }

    async deleteUser(id) {
      try {
        const { error } = await supabase.from('profiles').delete().eq('id', id);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── SHOPS ──
    async getShops() {
      try {
        const { data, error } = await supabase.from('shops').select('*').order('name');
        if (error) throw error;
        const mapped = data.map(s => ({
          id: s.id, name: s.name, address: s.address,
          taxId: s.tax_id, phone: s.phone, note: s.note
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveShop(shop) {
      try {
        const payload = {
          name: shop.name, address: shop.address,
          tax_id: shop.taxId, phone: shop.phone, note: shop.note
        };
        if (shop.id) {
          const { error } = await supabase.from('shops').update(payload).eq('id', shop.id);
          if (error) throw error;
          this._ok({ success: true });
        } else {
          const { data, error } = await supabase.from('shops').insert(payload).select().single();
          if (error) throw error;
          this._ok({ success: true, id: data.id });
        }
      } catch (err) { this._err(err); }
    }

    async deleteShop(id) {
      try {
        const { error } = await supabase.from('shops').delete().eq('id', id);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── BUSES ──
    async getBusPlates() {
      try {
        const { data, error } = await supabase.from('buses').select('plate').order('plate');
        if (error) throw error;
        this._ok((data || []).map(b => b.plate));
      } catch (err) { this._err(err); }
    }

    async getFullBuses() {
      try {
        const { data, error } = await supabase.from('buses').select('*').order('plate');
        if (error) throw error;
        const mapped = data.map(b => ({
          plate: b.plate, chassis: b.chassis, model: b.model, year: b.year,
          color: b.color, engineNo: b.engine_no, lastInspect: b.last_inspect,
          regExpiry: b.reg_expiry, insuranceExpiry: b.insurance_expiry, note: b.note
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveBus(bus) {
      try {
        const payload = {
          plate: bus.plate, chassis: bus.chassis, model: bus.model, year: bus.year,
          color: bus.color, engine_no: bus.engineNo, last_inspect: bus.lastInspect || null,
          reg_expiry: bus.regExpiry || null, insurance_expiry: bus.insuranceExpiry || null, note: bus.note
        };
        
        const searchPlate = bus.oldPlate || bus.plate;
        if (bus.oldPlate && bus.oldPlate !== bus.plate) {
          // Plate changed, do update or delete old and insert new
          await supabase.from('buses').delete().eq('plate', bus.oldPlate);
          const { error } = await supabase.from('buses').insert(payload);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('buses').upsert(payload);
          if (error) throw error;
        }
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    async deleteBus(plate) {
      try {
        const { error } = await supabase.from('buses').delete().eq('plate', plate);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── REPAIRS ──
    async getRepairs() {
      try {
        const { data, error } = await supabase.from('repairs').select('*').order('repair_no', { ascending: false });
        if (error) throw error;
        const mapped = data.map(r => ({
          repairNo: r.repair_no, date: r.date, plate: r.plate, chassis: r.chassis,
          mileage: r.mileage, oilProgram: r.oil_program, repairList: r.repair_list,
          repairSummary: r.repair_summary, status: r.status, createdBy: r.created_by,
          createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async getRepairParts(repairNo) {
      try {
        const { data, error } = await supabase.from('repair_parts').select('*').eq('repair_no', repairNo);
        if (error) throw error;
        this._ok(data.map(p => ({ repairNo: p.repair_no, partName: p.part_name, qty: p.qty })));
      } catch (err) { this._err(err); }
    }

    async saveRepair(repair, parts) {
      try {
        let repairNo = repair.repairNo;
        
        // Generate repair number if new
        if (!repairNo) {
          const now = new Date();
          const yy = String(now.getFullYear()).slice(-2);
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const prefix = `REP${yy}${mm}`;
          
          const { data: latest } = await supabase.from('repairs')
            .select('repair_no')
            .like('repair_no', `${prefix}%`)
            .order('repair_no', { ascending: false })
            .limit(1);
            
          let maxVal = 0;
          if (latest && latest.length > 0) {
            maxVal = parseInt(latest[0].repair_no.slice(-4)) || 0;
          }
          repairNo = prefix + String(maxVal + 1).padStart(4, '0');
        }

        const payload = {
          repair_no: repairNo,
          date: repair.date,
          plate: repair.plate,
          chassis: repair.chassis,
          mileage: parseInt(repair.mileage) || 0,
          oil_program: repair.oilProgram || '',
          repair_list: repair.repairList || '',
          repair_summary: repair.repairSummary || '',
          created_by: repair.createdBy
        };

        if (repair.repairNo) {
          // updating existing, verify not "เสร็จแล้ว"
          const { data: check } = await supabase.from('repairs').select('status').eq('repair_no', repairNo).single();
          if (check && check.status === 'เสร็จแล้ว') {
            throw new Error('ไม่อนุญาตให้แก้ไขใบแจ้งซ่อมที่ปิดงานเสร็จสิ้นแล้ว');
          }
          const { error } = await supabase.from('repairs').update(payload).eq('repair_no', repairNo);
          if (error) throw error;
        } else {
          payload.status = 'รอดำเนินการ';
          const { error } = await supabase.from('repairs').insert(payload);
          if (error) throw error;
        }

        // Delete old parts and insert new
        await supabase.from('repair_parts').delete().eq('repair_no', repairNo);
        if (parts && parts.length > 0) {
          const partsPayload = parts.map(p => ({
            repair_no: repairNo,
            part_name: p.partName,
            qty: parseFloat(p.qty) || 1
          }));
          const { error } = await supabase.from('repair_parts').insert(partsPayload);
          if (error) throw error;
        }

        this._ok({ success: true, repairNo });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async changeRepairStatusDirect(repairNo, status) {
      try {
        const { error } = await supabase.from('repairs').update({ status }).eq('repair_no', repairNo);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── PURCHASE ORDERS ──
    async getPOs() {
      try {
        const { data, error } = await supabase.from('purchase_orders').select('*').order('po_no', { ascending: false });
        if (error) throw error;
        const mapped = data.map(po => ({
          poNo: po.po_no, shopName: po.shop_name, shopAddress: po.shop_address, taxId: po.tax_id,
          issueDate: po.issue_date, quoteDate: po.quote_date, refRepairNo: po.ref_repair_no,
          quoteNo: po.quote_no, plate: po.plate, vatType: po.vat_type, status: po.status,
          createdBy: po.created_by, createdAt: po.created_at, createdBySignatureUrl: po.created_by_signature_url,
          approvedBy: po.approved_by, approvedAt: po.approved_at, lineSentAt: po.line_sent_at,
          pdfUrl: po.pdf_url, grpRef: po.grp_ref, quoteNoIsAuto: po.quote_no_is_auto, printedAt: po.printed_at
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async getPOItems(poNo) {
      try {
        const { data, error } = await supabase.from('po_items').select('*').eq('po_no', poNo);
        if (error) throw error;
        this._ok(data.map(i => ({
          poNo: i.po_no, partName: i.part_name, qty: i.qty, unit: i.unit,
          pricePerUnit: i.price_per_unit, discount: i.discount, amount: i.amount, note: i.note
        })));
      } catch (err) { this._err(err); }
    }

    async savePO(po, items) {
      try {
        let poNo = po.poNo;

        if (!poNo) {
          const now = new Date();
          const yy = String(now.getFullYear()).slice(-2);
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const prefix = `PO${yy}${mm}`;
          
          const { data: latest } = await supabase.from('purchase_orders')
            .select('po_no')
            .like('po_no', `${prefix}%`)
            .order('po_no', { ascending: false })
            .limit(1);
            
          let maxVal = 0;
          if (latest && latest.length > 0) {
            maxVal = parseInt(latest[0].po_no.slice(-4)) || 0;
          }
          poNo = prefix + String(maxVal + 1).padStart(4, '0');
        }

        const payload = {
          po_no: poNo,
          shop_name: po.shopName,
          shop_address: po.shopAddress || '',
          tax_id: po.taxId || '',
          issue_date: po.issueDate,
          quote_date: po.quoteDate || null,
          ref_repair_no: po.refRepairNo || null,
          quote_no: po.quoteNo || '',
          plate: po.plate || null,
          vat_type: po.vatType || 'none',
          grp_ref: po.grpRef || '',
          quote_no_is_auto: po.quoteNoIsAuto === true || po.quoteNoIsAuto === 'true'
        };

        if (po.poNo) {
          const { error } = await supabase.from('purchase_orders').update(payload).eq('po_no', poNo);
          if (error) throw error;
        } else {
          payload.status = 'รออนุมัติ';
          payload.created_by = window.currentUser?.name || '';
          payload.created_by_signature_url = window.currentUser?.signatureUrl || '';
          const { error } = await supabase.from('purchase_orders').insert(payload);
          if (error) throw error;
        }

        // Delete items and recreate
        await supabase.from('po_items').delete().eq('po_no', poNo);
        if (items && items.length > 0) {
          const itemsPayload = items.map(item => ({
            po_no: poNo,
            part_name: item.partName,
            qty: parseFloat(item.qty) || 1,
            unit: item.unit || 'ชิ้น',
            price_per_unit: parseFloat(item.pricePerUnit) || 0,
            discount: parseFloat(item.discount) || 0,
            amount: parseFloat(item.amount) || 0,
            note: item.note || ''
          }));
          const { error } = await supabase.from('po_items').insert(itemsPayload);
          if (error) throw error;
        }

        this._ok({ success: true, poNo });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async deletePO(poNo) {
      try {
        const { error } = await supabase.from('purchase_orders').delete().eq('po_no', poNo);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    async changePOStatusDirect(poNo, status) {
      try {
        const { error } = await supabase.from('purchase_orders').update({ status }).eq('po_no', poNo);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── STOCK ──
    async getStock() {
      try {
        const { data, error } = await supabase.from('stock').select('*').order('part_name');
        if (error) throw error;
        const mapped = data.map(s => ({
          id: s.id, partCode: s.part_code, partName: s.part_name, unit: s.unit,
          qty: s.qty, minQty: s.min_qty, location: s.location, note: s.note
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveStockItem(item) {
      try {
        const payload = {
          part_code: item.partCode, part_name: item.partName, unit: item.unit,
          qty: parseFloat(item.qty) || 0, min_qty: parseFloat(item.minQty) || 0,
          location: item.location, note: item.note
        };
        if (item.id) {
          const { error } = await supabase.from('stock').update(payload).eq('id', item.id);
          if (error) throw error;
          this._ok({ success: true });
        } else {
          const { data, error } = await supabase.from('stock').insert(payload).select().single();
          if (error) throw error;
          this._ok({ success: true, id: data.id });
        }
      } catch (err) { this._err(err); }
    }

    async deleteStockItem(id) {
      try {
        const { error } = await supabase.from('stock').delete().eq('id', id);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    async getStockLog(limit) {
      try {
        let query = supabase.from('stock_logs').select('*').order('timestamp', { ascending: false });
        if (limit) query = query.limit(limit);
        const { data, error } = await query;
        if (error) throw error;
        const mapped = data.map(l => ({
          timestamp: l.timestamp, type: l.type, partName: l.part_name,
          qty: l.qty, ref: l.ref, logId: l.log_id
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    // ── OIL TEMPLATES ──
    async getOilTemplates() {
      try {
        const { data, error } = await supabase.from('oil_templates').select('*');
        if (error) throw error;
        const mapped = data.map(t => ({
          plate: t.plate, program: t.program, partName: t.part_name,
          qty: t.qty, unit: t.unit, pricePerUnit: t.price_per_unit
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async saveOilTemplate(plate, program, items) {
      try {
        // Delete old and recreate
        await supabase.from('oil_templates').delete().eq('plate', plate).eq('program', program);
        if (items && items.length > 0) {
          const payload = items.map(item => ({
            plate: plate,
            program: program,
            part_name: item.partName,
            qty: parseFloat(item.qty) || 1,
            unit: item.unit || 'ชิ้น',
            price_per_unit: parseFloat(item.pricePerUnit) || 0
          }));
          const { error } = await supabase.from('oil_templates').insert(payload);
          if (error) throw error;
        }
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── NOTIFICATIONS ──
    async getNotifications() {
      try {
        const [repairsRes, posRes, stockRes] = await Promise.all([
          supabase.from('repairs').select('*'),
          supabase.from('purchase_orders').select('*'),
          supabase.from('stock').select('*')
        ]);

        if (repairsRes.error) throw repairsRes.error;
        if (posRes.error) throw posRes.error;
        if (stockRes.error) throw stockRes.error;

        const repairs = repairsRes.data || [];
        const pos = posRes.data || [];
        const stock = stockRes.data || [];
        const notifications = [];

        // 1. PO อนุมัติแล้ว รอปริ้น (p.status === 'อนุมัติแล้ว')
        pos.filter(p => p.status === 'อนุมัติแล้ว').forEach(p => {
          notifications.push({
            id: p.po_no,
            type: 'po_approved',
            title: 'PO อนุมัติแล้ว',
            body: `${p.po_no} | ${p.shop_name}`,
            action: 'po',
            ref: p.po_no,
            date: p.approved_at || p.issue_date
          });
        });

        // 2. Job ซ่อมอนุมัติแล้ว (กำลังซ่อม) รอแจ้งช่าง
        repairs.filter(r => r.status === 'กำลังซ่อม').forEach(r => {
          notifications.push({
            id: r.repair_no,
            type: 'repair_approved',
            title: 'อนุมัติซ่อมแล้ว',
            body: `${r.repair_no} | ${r.plate}`,
            action: 'repairs',
            ref: r.repair_no,
            date: r.approved_at || r.date
          });
        });

        // 3. PO รออนุมัติ (สำหรับ admin)
        pos.filter(p => p.status === 'รออนุมัติ').forEach(p => {
          notifications.push({
            id: p.po_no,
            type: 'po_pending',
            title: 'PO รออนุมัติ',
            body: `${p.po_no} | ${p.shop_name}`,
            action: 'po',
            ref: p.po_no,
            date: p.issue_date
          });
        });

        // 4. Stock ใกล้หมด
        stock.filter(s => parseFloat(s.qty) <= parseFloat(s.min_qty || 0) && parseFloat(s.min_qty) > 0)
          .forEach(s => {
            notifications.push({
              id: s.id,
              type: 'stock_low',
              title: 'อะไหล่ใกล้หมด',
              body: `${s.part_name} เหลือ ${s.qty} ${s.unit}`,
              action: 'stock',
              ref: s.id,
              date: new Date().toISOString()
            });
          });

        notifications.sort((a, b) => new Date(b.date) - new Date(a.date));
        this._ok(notifications);
      } catch (err) { this._err(err); }
    }

    async markNotificationAsRead(id) {
      this._ok({ success: true });
    }

    // ── LINE LOGS ──
    async getLineLogs() {
      try {
        const { data, error } = await supabase.from('line_logs').select('*').order('timestamp', { ascending: false }).limit(200);
        if (error) throw error;
        this._ok(data.map(l => ({ timestamp: l.timestamp, stage: l.stage, detail: l.detail })));
      } catch (err) { this._err(err); }
    }

    // ── INTEGRATIONS: LINE SENDS AND PDF TRIGGER ──
    async sendPOToLineDirect(poNo) {
      try {
        const res = await fetch(`/.netlify/functions/line-send-po?poNo=${poNo}`, { method: 'POST' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to send PO to LINE');
        this._ok(json);
      } catch (err) { this._err(err); }
    }

    async sendRepairToLineDirect(repairNo) {
      try {
        const res = await fetch(`/.netlify/functions/line-send-repair?repairNo=${repairNo}`, { method: 'POST' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to send Repair request to LINE');
        this._ok(json);
      } catch (err) { this._err(err); }
    }

    async generateAndSavePOPdf(poNo) {
      try {
        const res = await fetch(`/.netlify/functions/generate-pdf?poNo=${poNo}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to generate PDF');
        this._ok({ success: true, pdfUrl: json.pdfUrl });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async markPOAsPrinted(poNo) {
      try {
        const { error } = await supabase.from('purchase_orders').update({ printed_at: new Date().toISOString() }).eq('po_no', poNo);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._err(err); }
    }

    // ── SUMMARIES / REPORTING ──
    async getWeeklySummary(weekOffset) {
      try {
        weekOffset = parseInt(weekOffset) || 0;
        const now = new Date();
        const day = now.getDay();
        const diff = (day === 0 ? -6 : 1 - day);
        const monday = new Date(now);
        monday.setDate(now.getDate() + diff + weekOffset * 7);
        monday.setHours(0, 0, 0, 0);

        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        // Fetch repairs
        const { data: repairs, error } = await supabase
          .from('repairs')
          .select('*');
        if (error) throw error;

        const mappedRepairs = (repairs || []).map(r => ({
          repairNo: r.repair_no,
          date: r.date,
          plate: r.plate,
          chassis: r.chassis,
          mileage: r.mileage,
          oilProgram: r.oil_program,
          repairList: r.repair_list,
          repairSummary: r.repair_summary,
          status: r.status,
          createdBy: r.created_by,
          createdAt: r.created_at,
          approvedBy: r.approved_by,
          approvedAt: r.approved_at
        }));

        const openedThisWeek = mappedRepairs.filter(r => {
          const d = new Date(r.createdAt || r.date);
          return d >= monday && d <= sunday;
        });

        const allPending = mappedRepairs.filter(r => r.status !== 'เสร็จแล้ว');

        const doneThisWeek = mappedRepairs.filter(r => {
          if (r.status !== 'เสร็จแล้ว') return false;
          const d = new Date(r.createdAt || r.date);
          return d >= monday && d <= sunday;
        });

        const carryOver = mappedRepairs.filter(r => {
          if (r.status === 'เสร็จแล้ว') return false;
          const d = new Date(r.createdAt || r.date);
          return d < monday;
        });

        const byStatus = {};
        allPending.forEach(r => {
          byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        });

        const byPlate = {};
        openedThisWeek.forEach(r => {
          byPlate[r.plate] = (byPlate[r.plate] || 0) + 1;
        });
        const topPlates = Object.entries(byPlate)
          .map(([plate, count]) => ({ plate, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3);

        const pendingDetails = allPending
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        // Format label Helper
        const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
        const formatLabel = (mon, sun) => {
          return `${mon.getDate()} ${months[mon.getMonth()]} - ${sun.getDate()} ${months[sun.getMonth()]} ${sun.getFullYear() + 543}`;
        };

        this._ok({
          success: true,
          weekLabel: formatLabel(monday, sunday),
          monday: monday.toISOString(),
          sunday: sunday.toISOString(),
          weekOffset,
          openedCount: openedThisWeek.length,
          doneCount: doneThisWeek.length,
          pendingCount: allPending.length,
          carryOverCount: carryOver.length,
          byStatus,
          topPlates,
          pendingDetails
        });
      } catch (err) { this._err(err); }
    }

    async getExpenseSummary(filter) {
      try {
        // Fetch POs
        const { data: pos, error: poErr } = await supabase
          .from('purchase_orders')
          .select('*');
        if (poErr) throw poErr;

        // Fetch PO items to calculate totals
        const { data: poItems, error: itemsErr } = await supabase
          .from('po_items')
          .select('po_no, amount');
        if (itemsErr) throw itemsErr;

        const poTotals = {};
        (poItems || []).forEach(item => {
          const poNo = item.po_no;
          const amt = parseFloat(item.amount) || 0;
          poTotals[poNo] = (poTotals[poNo] || 0) + amt;
        });

        const from = filter?.from ? new Date(filter.from) : null;
        const to = filter?.to ? new Date(filter.to) : null;
        if (to) to.setHours(23, 59, 59, 999);

        const mappedPOs = (pos || []).map(p => ({
          poNo: p.po_no,
          shopName: p.shop_name,
          shopAddress: p.shop_address,
          taxId: p.tax_id,
          issueDate: p.issue_date,
          quoteDate: p.quote_date,
          refRepairNo: p.ref_repair_no,
          quoteNo: p.quote_no,
          plate: p.plate,
          vatType: p.vat_type,
          status: p.status,
          createdBy: p.created_by,
          createdAt: p.created_at,
          approvedBy: p.approved_by,
          approvedAt: p.approved_at
        }));

        const filteredPO = mappedPOs.filter(p => {
          if (p.status !== 'รับของแล้ว') return false;
          const d = new Date(p.issueDate);
          if (from && d < from) return false;
          if (to && d > to) return false;
          if (filter?.plate && p.plate !== filter.plate) return false;
          if (filter?.shopName && p.shopName !== filter.shopName) return false;
          return true;
        }).map(p => ({ ...p, total: poTotals[p.poNo] || 0, source: 'PO' }));

        // Manual Deduct OUT-MANUAL from stock_logs
        const { data: logs, error: logsErr } = await supabase
          .from('stock_logs')
          .select('*')
          .eq('type', 'OUT-MANUAL');
        if (logsErr) throw logsErr;

        const manualRows = [];
        (logs || []).forEach(log => {
          const ref = log.ref || '';
          // parse ref string "วันที่:xxx | ทะเบียน:xxx | ราคา:xxx | หมายเหตุ:xxx"
          const getVal = key => (ref.match(new RegExp(key + ':([^|]+)')) || [])[1]?.trim() || '';
          const dateStr = getVal('วันที่');
          const plate = getVal('ทะเบียน');
          const price = parseFloat(getVal('ราคา')) || 0;
          const noteStr = getVal('หมายเหตุ');
          const qty = parseFloat(log.qty) || 0;
          const amount = price * qty;

          if (!dateStr || !plate) return;

          const d = new Date(dateStr);
          if (from && d < from) return;
          if (to && d > to) return;
          if (filter?.plate && plate !== filter.plate) return;

          manualRows.push({
            poNo: 'MANUAL',
            issueDate: dateStr,
            plate,
            shopName: '— ตัดโดยตรง —',
            refRepairNo: noteStr,
            total: amount,
            source: 'MANUAL',
            partName: log.part_name || '',
            qty
          });
        });

        const allRows = [...filteredPO, ...manualRows];
        const grandTotal = allRows.reduce((s, r) => s + r.total, 0);

        const byPlate = {};
        allRows.forEach(r => {
          if (!byPlate[r.plate]) byPlate[r.plate] = 0;
          byPlate[r.plate] += r.total;
        });

        const byShop = {};
        allRows.forEach(r => {
          if (!byShop[r.shopName]) byShop[r.shopName] = 0;
          byShop[r.shopName] += r.total;
        });

        const byMonth = {};
        allRows.forEach(r => {
          const d = new Date(r.issueDate);
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
          byMonth[key] = (byMonth[key] || 0) + r.total;
        });

        this._ok({
          success: true,
          total: grandTotal,
          count: allRows.length,
          byPlate: Object.entries(byPlate)
            .map(([plate, total]) => ({ plate, total }))
            .sort((a, b) => b.total - a.total),
          byShop: Object.entries(byShop)
            .map(([shop, total]) => ({ shop, total }))
            .sort((a, b) => b.total - a.total),
          byMonth: Object.entries(byMonth)
            .map(([month, total]) => ({ month, total }))
            .sort((a, b) => a.month.localeCompare(b.month)),
          detail: allRows.sort((a, b) => new Date(b.issueDate) - new Date(a.issueDate))
        });
      } catch (err) { this._err(err); }
    }
  }

  // Define global google.script.run emulation!
  window.google = {
    script: {
      run: new Proxy({}, {
        get(target, prop) {
          // Return a fresh script bridge instance per call
          const bridge = new ScriptRunBridge();
          return function(...args) {
            if (typeof bridge[prop] === 'function') {
              // Execute the mapped method
              bridge[prop](...args);
            } else {
              console.warn(`Bridge function "${prop}" not implemented.`);
              bridge._err(new Error(`Function ${prop} not implemented in Supabase bridge.`));
            }
            return bridge;
          };
        }
      })
    }
  };
})();
