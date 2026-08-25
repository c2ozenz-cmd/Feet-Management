// Supabase compatibility layer for the frontend command API.
// This maps existing UI calls to Supabase and Netlify Functions.

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

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return date.toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Bridge class for the frontend command API.
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

    _makeId(prefix) {
      return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
    }

    _responseErrorMessage(json, fallback) {
      return json?.error || json?.message || fallback;
    }

    async _generatePartCodeValue() {
      const prefix = 'P';
      const { data, error } = await supabase
        .from('stock')
        .select('part_code')
        .like('part_code', `${prefix}%`)
        .limit(10000);
      if (error) throw error;
      const usedNumbers = new Set();
      let maxNumber = 0;
      (data || []).forEach(row => {
        const code = String(row.part_code || '').trim().toUpperCase();
        if (!/^P\d+$/.test(code)) return;
        const num = parseInt(code.slice(1), 10) || 0;
        if (num > 0) {
          usedNumbers.add(num);
          maxNumber = Math.max(maxNumber, num);
        }
      });
      let next = maxNumber + 1;
      while (usedNumbers.has(next)) next++;
      return `${prefix}${String(next).padStart(4, '0')}`;
    }

    async _logStockTransaction(type, partName, qty, ref, logId) {
      const { error } = await supabase.from('stock_logs').insert({
        type,
        part_name: partName,
        qty: parseFloat(qty) || 0,
        ref: ref || '',
        log_id: logId || this._makeId('LOG')
      });
      if (error) throw error;
    }

    async _addStockFromPO(poNo) {
      const alreadySynced = await this._hasPOStockInLogs(poNo);
      if (alreadySynced) return false;

      const { data: items, error: itemsErr } = await supabase
        .from('po_items')
        .select('*')
        .eq('po_no', poNo);
      if (itemsErr) throw itemsErr;

      for (const item of (items || [])) {
        const partName = item.part_name;
        const qty = parseFloat(item.qty) || 0;
        if (!partName || qty <= 0) continue;

        const { data: stockRows, error: stockErr } = await supabase
          .from('stock')
          .select('*')
          .eq('part_name', partName)
          .limit(1);
        if (stockErr) throw stockErr;

        const existing = (stockRows || [])[0];
        if (existing) {
          const { error } = await supabase
            .from('stock')
            .update({ qty: (parseFloat(existing.qty) || 0) + qty })
            .eq('id', existing.id);
          if (error) throw error;
        } else {
          const partCode = await this._generatePartCodeValue();
          const { error } = await supabase.from('stock').insert({
            id: this._makeId('STK'),
            part_code: partCode,
            part_name: partName,
            unit: item.unit || 'ชิ้น',
            qty,
            min_qty: 0,
            location: '',
            note: `นำเข้าจาก PO: ${poNo}`
          });
          if (error) throw error;
        }

        await this._logStockTransaction('IN', partName, qty, `PO: ${poNo}`);
      }
      return true;
    }

    async _hasPOStockInLogs(poNo) {
      const { data, error } = await supabase
        .from('stock_logs')
        .select('id')
        .eq('type', 'IN')
        .eq('ref', `PO: ${poNo}`)
        .limit(1);
      if (error) throw error;
      return (data || []).length > 0;
    }

    async _rollbackStockFromPO(poNo) {
      const { data: logs, error: logsErr } = await supabase
        .from('stock_logs')
        .select('*')
        .in('type', ['IN', 'ROLLBACK'])
        .eq('ref', `PO: ${poNo}`);
      if (logsErr) throw logsErr;

      const netQtyByPart = new Map();
      (logs || []).forEach(log => {
        const partName = String(log.part_name || '').trim();
        if (!partName) return;
        const qty = parseFloat(log.qty) || 0;
        const sign = log.type === 'ROLLBACK' ? -1 : 1;
        netQtyByPart.set(partName, (netQtyByPart.get(partName) || 0) + (qty * sign));
      });

      let rollbackCount = 0;
      for (const [partName, qty] of netQtyByPart.entries()) {
        const rollbackQty = Math.max(0, qty);
        if (rollbackQty <= 0) continue;

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
          .update({ qty: Math.max(0, currentQty - rollbackQty) })
          .eq('id', stock.id);
        if (updateErr) throw updateErr;

        await this._logStockTransaction('ROLLBACK', partName, rollbackQty, `PO: ${poNo}`);
        rollbackCount++;
      }

      return rollbackCount;
    }

    async _rollbackPOPartsFromRepair(poNo) {
      const { data: po, error: poErr } = await supabase
        .from('purchase_orders')
        .select('ref_repair_no')
        .eq('po_no', poNo)
        .single();
      if (poErr) throw poErr;
      const repairNo = po?.ref_repair_no;
      if (!repairNo) return 0;

      const { data: items, error: itemsErr } = await supabase
        .from('po_items')
        .select('*')
        .eq('po_no', poNo);
      if (itemsErr) throw itemsErr;

      let rollbackCount = 0;
      for (const item of (items || [])) {
        const partName = item.part_name;
        const qty = parseFloat(item.qty) || 0;
        if (!partName || qty <= 0) continue;

        const { data: existing, error: existingErr } = await supabase
          .from('repair_parts')
          .select('*')
          .eq('repair_no', repairNo)
          .eq('part_name', partName)
          .maybeSingle();
        if (existingErr) throw existingErr;
        if (!existing) continue;

        const nextQty = (parseFloat(existing.qty) || 0) - qty;
        const op = nextQty > 0
          ? supabase.from('repair_parts').update({ qty: nextQty }).eq('id', existing.id)
          : supabase.from('repair_parts').delete().eq('id', existing.id);
        const { error } = await op;
        if (error) throw error;
        rollbackCount++;
      }

      return rollbackCount;
    }

    async _syncPOPartsToRepair(poNo) {
      const { data: po, error: poErr } = await supabase
        .from('purchase_orders')
        .select('ref_repair_no')
        .eq('po_no', poNo)
        .single();
      if (poErr) throw poErr;
      const repairNo = po?.ref_repair_no;
      if (!repairNo) return;

      const { data: items, error: itemsErr } = await supabase
        .from('po_items')
        .select('*')
        .eq('po_no', poNo);
      if (itemsErr) throw itemsErr;

      for (const item of (items || [])) {
        const partName = item.part_name;
        if (!partName) continue;
        const { data: existing, error: existingErr } = await supabase
          .from('repair_parts')
          .select('*')
          .eq('repair_no', repairNo)
          .eq('part_name', partName)
          .maybeSingle();
        if (existingErr) throw existingErr;

        const qty = parseFloat(item.qty) || 0;
        if (existing) {
          const { error } = await supabase
            .from('repair_parts')
            .update({ qty: (parseFloat(existing.qty) || 0) + qty })
            .eq('id', existing.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('repair_parts').insert({
            repair_no: repairNo,
            part_name: partName,
            qty
          });
          if (error) throw error;
        }
      }
    }

    async _deductStockForRepair(repairNo) {
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
        await this._logStockTransaction('OUT', partName, deductQty, `Repair: ${repairNo}`);
      }
    }

    async _restoreStockForRepair(repairNo) {
      const { data: logs, error: logsErr } = await supabase
        .from('stock_logs')
        .select('*')
        .eq('type', 'OUT')
        .eq('ref', `Repair: ${repairNo}`);
      if (logsErr) throw logsErr;

      let restoredCount = 0;
      for (const log of (logs || [])) {
        const { data: stockRows, error: stockErr } = await supabase
          .from('stock')
          .select('*')
          .eq('part_name', log.part_name)
          .limit(1);
        if (stockErr) throw stockErr;
        const stock = (stockRows || [])[0];
        if (stock) {
          const { error: updateErr } = await supabase
            .from('stock')
            .update({ qty: (parseFloat(stock.qty) || 0) + (parseFloat(log.qty) || 0) })
            .eq('id', stock.id);
          if (updateErr) throw updateErr;
          restoredCount++;
        }
        await supabase.from('stock_logs').delete().eq('id', log.id);
      }
      return restoredCount;
    }

    // ── AUTH / LOGIN ──
    async login(username, password) {
      try {
        const res = await fetch('/.netlify/functions/auth-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw new Error(json.message || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        }

        window.currentUser = json.user;
        window.appSessionToken = json.token || '';

        this._ok({ success: true, user: json.user, token: json.token || '' });
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
        const normalized = Array.isArray(settingsObj)
          ? settingsObj
              .filter(item => item && item.key)
              .map(item => ({ key: String(item.key).trim(), value: String(item.value ?? '') }))
          : Object.keys(settingsObj || {}).map(key => ({
              key: String(key).trim(),
              value: String(settingsObj[key] ?? '')
            }));

        const settingsMap = new Map();
        normalized.forEach(item => {
          if (item.key) settingsMap.set(item.key, item.value);
        });
        const upserts = Array.from(settingsMap, ([key, value]) => ({ key, value }));

        const { data: existingRows, error: fetchError } = await supabase.from('settings').select('key');
        if (fetchError) throw fetchError;

        const nextKeys = new Set(upserts.map(item => item.key));
        const keysToDelete = (existingRows || [])
          .map(row => row.key)
          .filter(key => key && !nextKeys.has(key));

        if (keysToDelete.length) {
          const { error: deleteError } = await supabase.from('settings').delete().in('key', keysToDelete);
          if (deleteError) throw deleteError;
        }

        if (upserts.length) {
          const { error } = await supabase.from('settings').upsert(upserts, { onConflict: 'key' });
          if (error) throw error;
        }
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
        const { data, error } = await supabase.from('buses').select('plate, chassis').order('plate');
        if (error) throw error;
        this._ok((data || []).map(b => ({
          plate: b.plate,
          chassis: b.chassis || ''
        })));
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

    async updateRepairStatus(repairNo, status) {
      try {
        const payload = { status };
        if (status === 'กำลังซ่อม') {
          payload.approved_by = window.currentUser?.name || '';
          payload.approved_at = new Date().toISOString();
        }
        const { error } = await supabase.from('repairs').update(payload).eq('repair_no', repairNo);
        if (error) throw error;
        if (status === 'เสร็จแล้ว') {
          await this._deductStockForRepair(repairNo);
        }
        this._ok({ success: true });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async deleteRepair(repairNo) {
      try {
        const { error } = await supabase.from('repairs').delete().eq('repair_no', repairNo);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._ok({ success: false, message: err.message }); }
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

    async getPOForPrint(poNo) {
      try {
        const [poRes, itemsRes, settingsRes] = await Promise.all([
          supabase.from('purchase_orders').select('*').eq('po_no', poNo).single(),
          supabase.from('po_items').select('*').eq('po_no', poNo),
          supabase.from('settings').select('*')
        ]);

        if (poRes.error || !poRes.data) throw new Error('PO not found: ' + (poRes.error?.message || poNo));
        if (itemsRes.error) throw itemsRes.error;
        if (settingsRes.error) throw settingsRes.error;

        const poRow = poRes.data;
        const po = {
          poNo: poRow.po_no,
          shopName: poRow.shop_name,
          shopAddress: poRow.shop_address,
          taxId: poRow.tax_id,
          issueDate: poRow.issue_date,
          quoteDate: poRow.quote_date,
          refRepairNo: poRow.ref_repair_no,
          quoteNo: poRow.quote_no,
          plate: poRow.plate,
          vatType: poRow.vat_type,
          status: poRow.status,
          createdBy: poRow.created_by,
          createdAt: poRow.created_at,
          createdBySignatureUrl: poRow.created_by_signature_url,
          approvedBy: poRow.approved_by,
          approvedAt: poRow.approved_at,
          lineSentAt: poRow.line_sent_at,
          pdfUrl: poRow.pdf_url,
          printedAt: poRow.printed_at
        };

        const items = (itemsRes.data || []).map(i => ({
          poNo: i.po_no,
          partName: i.part_name,
          qty: i.qty,
          unit: i.unit,
          pricePerUnit: i.price_per_unit,
          discount: i.discount,
          amount: i.amount,
          note: i.note
        }));

        const settings = (settingsRes.data || []).map(s => ({ key: s.key, value: s.value }));
        let sigUrl = '';
        if (poRow.approved_by) {
          const { data: approver } = await supabase
            .from('profiles')
            .select('signature_url')
            .eq('name', poRow.approved_by)
            .maybeSingle();
          sigUrl = approver?.signature_url || '';
        }

        this._ok({ po, items, settings, sigUrl });
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
          if (po.status) payload.status = po.status;
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

    async updatePOStatus(poNo, status, approvedBy, syncStock) {
      try {
        const payload = { status };
        if (status === 'อนุมัติแล้ว') {
          payload.approved_by = approvedBy || window.currentUser?.name || '';
          payload.approved_at = new Date().toISOString();
        }
        const { error } = await supabase.from('purchase_orders').update(payload).eq('po_no', poNo);
        if (error) throw error;

        if (status === 'รับของแล้ว' && syncStock !== false) {
          const addedStock = await this._addStockFromPO(poNo);
          if (addedStock) await this._syncPOPartsToRepair(poNo);
        } else if (syncStock && syncStock.rollbackPOStock) {
          await this._rollbackStockFromPO(poNo);
          await this._rollbackPOPartsFromRepair(poNo);
        }
        this._ok({ success: true });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    // ── STOCK ──
    async getStock() {
      try {
        const [{ data, error }, { data: poItems, error: itemsErr }] = await Promise.all([
          supabase.from('stock').select('*').order('part_name'),
          supabase.from('po_items').select('part_name, price_per_unit, created_at').order('created_at', { ascending: true })
        ]);
        if (error) throw error;
        if (itemsErr) throw itemsErr;
        const lastPrices = {};
        (poItems || []).forEach(item => {
          if (item.part_name) lastPrices[String(item.part_name).toLowerCase()] = parseFloat(item.price_per_unit) || 0;
        });
        const mapped = data.map(s => ({
          id: s.id, partCode: s.part_code, partName: s.part_name, unit: s.unit,
          qty: s.qty, minQty: s.min_qty, location: s.location, note: s.note,
          lastPrice: lastPrices[String(s.part_name || '').toLowerCase()] || 0
        }));
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async generatePartCode() {
      try {
        this._ok(await this._generatePartCodeValue());
      } catch (err) { this._err(err); }
    }

    async saveStockItem(item) {
      try {
        const isNewItem = !item.id;
        const payload = {
          part_code: item.partCode, part_name: item.partName, unit: item.unit,
          qty: parseFloat(item.qty) || 0, min_qty: parseFloat(item.minQty) || 0,
          location: item.location, note: item.note
        };
        if (isNewItem) {
          payload.part_code = await this._generatePartCodeValue();
        }
        if (item.id) {
          if (!payload.part_code) payload.part_code = await this._generatePartCodeValue();
          const { error } = await supabase.from('stock').update(payload).eq('id', item.id);
          if (error) throw error;
          this._ok({ success: true });
        } else {
          payload.id = this._makeId('STK');
          const { data, error } = await supabase.from('stock').insert(payload).select().single();
          if (error) throw error;
          this._ok({ success: true, id: data.id, partCode: data.part_code });
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

    async manualDeductStock(items, date, plate, note) {
      try {
        const results = [];
        for (const item of (items || [])) {
          const { data: stock, error: stockErr } = await supabase
            .from('stock')
            .select('*')
            .eq('id', item.stockId)
            .single();
          if (stockErr || !stock) {
            results.push({ partName: item.partName, stockId: item.stockId, error: 'ไม่พบอะไหล่' });
            continue;
          }

          const currentQty = parseFloat(stock.qty) || 0;
          const deductQty = parseFloat(item.qty) || 0;
          const newQty = Math.max(0, currentQty - deductQty);
          const price = parseFloat(item.pricePerUnit) || 0;
          const logId = this._makeId('LOG');
          const ref = `วันที่:${date} | ทะเบียน:${plate} | ราคา:${price} | หมายเหตุ:${note || '-'}`;

          const { error: updateErr } = await supabase
            .from('stock')
            .update({ qty: newQty })
            .eq('id', stock.id);
          if (updateErr) throw updateErr;
          await this._logStockTransaction('OUT-MANUAL', stock.part_name, deductQty, ref, logId);

          results.push({
            partName: stock.part_name,
            stockId: stock.id,
            before: currentQty,
            after: newQty,
            logId
          });
        }
        this._ok({ success: true, results });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async cancelDeductStock(logId) {
      try {
        if (!logId) throw new Error('logId ไม่ถูกต้อง');
        const { data: log, error: logErr } = await supabase
          .from('stock_logs')
          .select('*')
          .eq('log_id', logId)
          .single();
        if (logErr || !log) throw new Error('ไม่พบ logId: ' + logId);
        if (log.type === 'CANCEL') throw new Error('รายการนี้ถูกยกเลิกไปแล้ว');
        if (log.type !== 'OUT-MANUAL') throw new Error('ยกเลิกได้เฉพาะรายการตัดออก manual');

        const { data: stockRows, error: stockErr } = await supabase
          .from('stock')
          .select('*')
          .eq('part_name', log.part_name)
          .limit(1);
        if (stockErr) throw stockErr;
        const stock = (stockRows || [])[0];
        if (!stock) throw new Error(`ไม่พบอะไหล่ "${log.part_name}" ใน Stock`);

        const qty = parseFloat(log.qty) || 0;
        const { error: updateErr } = await supabase
          .from('stock')
          .update({ qty: (parseFloat(stock.qty) || 0) + qty })
          .eq('id', stock.id);
        if (updateErr) throw updateErr;

        const cancelRef = `${log.ref || ''} (ยกเลิกเมื่อ ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
        const { error: logUpdateErr } = await supabase
          .from('stock_logs')
          .update({ type: 'CANCEL', ref: cancelRef })
          .eq('log_id', logId);
        if (logUpdateErr) throw logUpdateErr;

        this._ok({ success: true, partName: log.part_name, qty });
      } catch (err) { this._ok({ success: false, message: err.message }); }
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

    async getOilTemplateByPlateProgram(plate, program) {
      try {
        const { data, error } = await supabase
          .from('oil_templates')
          .select('*')
          .eq('plate', plate)
          .eq('program', program)
          .order('id');
        if (error) throw error;
        this._ok((data || []).map(t => ({
          plate: t.plate,
          program: t.program,
          partName: t.part_name,
          qty: t.qty,
          unit: t.unit,
          pricePerUnit: t.price_per_unit
        })));
      } catch (err) { this._err(err); }
    }

    async getOilTemplateItems(program, plate) {
      return this.getOilTemplateByPlateProgram(plate, program);
    }

    async getOilProgramsByPlate(plate) {
      try {
        const { data, error } = await supabase
          .from('oil_templates')
          .select('program')
          .eq('plate', plate);
        if (error) throw error;
        this._ok([...new Set((data || []).map(r => r.program).filter(Boolean))]);
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
        const mapped = (data || []).map(l => {
          let detail = {};
          try {
            detail = typeof l.detail === 'string' ? JSON.parse(l.detail) : (l.detail || {});
          } catch (parseErr) {
            detail = { preview: l.detail || '' };
          }
          const stage = String(l.stage || '');
          const isPush = String(detail.method || stage).toLowerCase().includes('push');
          const success = detail.success !== false && !stage.includes('failed') && !stage.includes('error') && !stage.includes('denied') && !stage.includes('invalid');
          return {
            timestamp: l.timestamp ? formatDateTime(l.timestamp) : '',
            stage,
            detail: l.detail,
            method: detail.method || (isPush ? 'Push' : 'Reply'),
            msgType: detail.msgType || detail.type || (stage.includes('po') ? 'PO' : (stage.includes('repair') ? 'Repair' : 'LINE')),
            recipient: detail.recipient || detail.groupId || detail.lineUserId || '-',
            preview: detail.preview || detail.id || detail.data || stage,
            costStatus: detail.costStatus || (isPush ? 'คิดเงิน' : 'ฟรี'),
            code: detail.code || (success ? 200 : 500)
          };
        });
        this._ok(mapped);
      } catch (err) { this._err(err); }
    }

    async clearLineLogs() {
      try {
        const { error } = await supabase
          .from('line_logs')
          .delete()
          .neq('id', -1);
        if (error) throw error;
        this._ok({ success: true });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    // ── INTEGRATIONS: LINE SENDS AND PDF TRIGGER ──
    async sendPOToLineDirect(poNo) {
      try {
        const res = await fetch(`/.netlify/functions/line-send-po-status?poNo=${poNo}`, { method: 'POST' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(this._responseErrorMessage(json, 'Failed to send PO status to LINE'));
        this._ok(json);
      } catch (err) { this._err(err); }
    }

    async sendPOToLine(poNo) {
      return this.sendPOToLineDirect(poNo);
    }

    async forceSendPOToLine(poNo) {
      return this.sendPOToLineDirect(poNo);
    }

    async sendRepairToLineDirect(repairNo) {
      try {
        const res = await fetch(`/.netlify/functions/line-send-repair?repairNo=${repairNo}`, { method: 'POST' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(this._responseErrorMessage(json, 'Failed to send Repair request to LINE'));
        this._ok(json);
      } catch (err) { this._err(err); }
    }

    async sendRepairToLine(repairNo) {
      return this.sendRepairToLineDirect(repairNo);
    }

    async forceSendRepairToLine(repairNo) {
      return this.sendRepairToLineDirect(repairNo);
    }

    async sendPOsToLineQueue(poNos) {
      try {
        const results = [];
        const orderedPONos = [...new Set((poNos || []).map(poNo => String(poNo || '').trim().toUpperCase()).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
        for (const poNo of orderedPONos) {
          try {
            const res = await fetch(`/.netlify/functions/line-send-po-status?poNo=${encodeURIComponent(poNo)}`, { method: 'POST' });
            const json = await res.json().catch(() => ({}));
            results.push({ poNo, success: res.ok && json.success !== false, ...json });
          } catch (err) {
            results.push({ poNo, success: false, message: err.message });
          }
        }
        const sent = results.filter(r => r.success).length;
        const skipped = results.filter(r => r.alreadySent).length;
        const failed = results.length - sent - skipped;
        this._ok({ success: results.every(r => r.success || r.alreadySent), sent, skipped, failed, results });
      } catch (err) { this._ok({ success: false, message: err.message }); }
    }

    async getLineQuotaStatus() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('/.netlify/functions/line-quota', { signal: controller.signal });
        clearTimeout(timeoutId);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || json.error || 'Failed to fetch LINE quota');
        this._ok(json);
      } catch (err) {
        const isAbort = err?.name === 'AbortError';
        this._ok({
          success: false,
          temporary: isAbort,
          message: isAbort
            ? 'เช็กโควต้า LINE ไม่สำเร็จชั่วคราว: ใช้เวลานานเกินไป'
            : err.message
        });
      }
    }

    async generateAndSavePOPdf(poNo) {
      try {
        const res = await fetch(`/.netlify/functions/generate-pdf?poNo=${poNo}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(this._responseErrorMessage(json, 'Failed to generate PDF'));
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

    async unmarkPOAsPrinted(poNo) {
      try {
        const { error } = await supabase.from('purchase_orders').update({ printed_at: '' }).eq('po_no', poNo);
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
        const plates = Array.isArray(filter?.plates)
          ? filter.plates.filter(Boolean)
          : (filter?.plate ? [filter.plate] : []);
        const shopNames = Array.isArray(filter?.shopNames)
          ? filter.shopNames.filter(Boolean)
          : (filter?.shopName ? [filter.shopName] : []);

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
          if (plates.length && !plates.includes(p.plate)) return false;
          if (shopNames.length && !shopNames.includes(p.shopName)) return false;
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
          if (plates.length && !plates.includes(plate)) return;

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
