(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./oil-tracking-model'));
  else root.OilTrackingDemoStore = factory(root.OilTrackingModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(M) {
  'use strict';
  const KEY = 'feet:oil-tracking:demo:v1';
  function seed(asOf = M.today()) {
    const earlier = n => { const d = M.date(asOf); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const vehicles = [
      ['demo-bus', '30-1001 สข', 'bus'], ['demo-special', '30-5115 สข', 'bus'],
      ['demo-mini', '30-5456 สข', 'minibus'], ['demo-van', 'ฮท-1001 สข', 'van'],
      ['demo-special2', '30-5145 สข', ''], ['demo-mini2', '30-5455 สข', ''],
      ['demo-unknown', '30-1999 สข', ''], ['demo-missing', '30-1002 สข', 'bus'],
      ['demo-review', '30-1003 สข', 'bus'], ['demo-stale', '30-1004 สข', 'bus'],
      ['demo-bus2', '30-1005 สข', 'bus'], ['demo-van2', 'ฮท-1002 สข', 'van']
    ].map(([id, plate, type]) => ({ id, plate, type }));
    const services = [], readings = [];
    vehicles.forEach((v, i) => {
      if (v.id === 'demo-missing') return;
      services.push({ id: 'seed-oil-' + i, vehicleId: v.id, date: earlier(90), odometer: 100000, program: ['S','M','S2','L'][i % 4], repairRef: 'DEMO-REP-' + (i + 1), note: 'ข้อมูลจำลอง ไม่อ้างอิงใบซ่อมจริง', sequence: i * 2, actor: { id: 'demo-seed', name: 'ข้อมูลตัวอย่าง', role: 'admin' }, recordedAt: asOf + 'T00:00:00Z' });
      const distance = M.rule(v)?.km || 35000;
      readings.push({ id: 'seed-reading-' + i, vehicleId: v.id, date: v.id === 'demo-stale' ? earlier(45) : asOf, odometer: v.id === 'demo-review' ? 90000 : 100000 + (i === 1 ? distance - 1000 : i === 2 ? distance : 3000), source: 'manual', note: '', sequence: i * 2 + 1, actor: { id: 'demo-seed', name: 'ข้อมูลตัวอย่าง', role: 'admin' }, recordedAt: asOf + 'T00:00:00Z' });
    });
    return { schema: 1, mode: 'local-demo', revision: 0, seededOn: asOf, vehicles, services, readings, settings: M.clone(M.defaults), audit: [] };
  }
  function open(storage, actor, asOf = M.today(), id = () => globalThis.crypto.randomUUID()) {
    if (!actor?.id || !['admin', 'manager', 'user'].includes(actor.role)) throw new Error('ไม่มีสิทธิ์เข้าดูข้อมูล');
    let state;
    const raw = storage.getItem(KEY);
    if (!raw) { state = seed(asOf); storage.setItem(KEY, JSON.stringify(state)); }
    else {
      state = JSON.parse(raw);
      if (state.schema !== 1 || state.mode !== 'local-demo' || !['vehicles','services','readings','audit'].every(k => Array.isArray(state[k]))) throw new Error('ข้อมูลสาธิตเสียหาย ห้ามบันทึกทับ กรุณาสำรองข้อมูลก่อน');
      M.settings(state.settings);
    }
    const canWrite = actor.role === 'admin';
    const text = (v, max = 1000) => String(v || '').trim().slice(0, max);
    function commit(action, entityId, before, after, mutate) {
      if (!canWrite) throw new Error('เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
      const current = JSON.parse(storage.getItem(KEY));
      if (current.revision !== state.revision) throw new Error('ข้อมูลเปลี่ยนจากหน้าจออื่น กรุณารีเฟรชก่อนบันทึก');
      const next = M.clone(state);
      mutate(next);
      next.audit.push({ id: id(), action, entityId, before: M.clone(before), after: M.clone(after), actor: M.clone(actor), timestamp: new Date().toISOString() });
      next.revision++;
      storage.setItem(KEY, JSON.stringify(next));
      state = next;
      return M.clone(after);
    }
    function append(kind, input) {
      if (!canWrite) throw new Error('เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
      if (!state.vehicles.some(v => v.id === input.vehicleId)) throw new Error('ไม่พบรถในชุดข้อมูลจำลอง');
      const events = state[kind];
      const previous = input.supersedes ? M.effective(events).find(e => e.id === input.supersedes && e.vehicleId === input.vehicleId) : null;
      if (input.supersedes && !previous) throw new Error('รายการเดิมถูกแก้ไขแล้ว กรุณารีเฟรช');
      if (previous && !text(input.reason)) throw new Error('กรุณาระบุเหตุผลการแก้ไข');
      const event = { id: id(), vehicleId: input.vehicleId, date: input.date, odometer: M.mileage(input.odometer), note: text(input.note), supersedes: previous?.id || null, reason: text(input.reason), sequence: state.revision + 100, actor: M.clone(actor), recordedAt: new Date().toISOString() };
      if (kind === 'services') {
        if (!['S', 'M', 'S2', 'L'].includes(input.program)) throw new Error('กรุณาเลือกโปรแกรม S/M/S2/L');
        event.program = input.program; event.repairRef = text(input.repairRef, 100);
      } else event.source = 'manual';
      const oils = M.effective(kind === 'services' ? [...events, event] : state.services).filter(e => e.vehicleId === input.vehicleId);
      const reads = M.effective(kind === 'readings' ? [...events, event] : state.readings).filter(e => e.vehicleId === input.vehicleId);
      M.validateTimeline(oils, reads, asOf);
      if (!previous) {
        const last = M.latest(M.effective(events).filter(e => e.vehicleId === input.vehicleId));
        if (last && event.date === last.date && event.odometer < last.odometer) throw new Error('เลขไมล์ลดลงจากรายการล่าสุดของวันเดียวกัน');
      }
      return commit(previous ? kind + '.correct' : kind + '.create', event.vehicleId, previous, event, next => next[kind].push(event));
    }
    return {
      canWrite, snapshot: () => M.clone(state),
      service: input => append('services', input), reading: input => append('readings', input),
      configure(input) { const value = M.settings(input); return commit('settings.update', 'oil-tracking', state.settings, value, next => { next.settings = value; }); },
      classify(vehicleId, type, reason) {
        if (!['', 'bus', 'minibus', 'van'].includes(type)) throw new Error('ประเภทรถไม่ถูกต้อง');
        const before = state.vehicles.find(v => v.id === vehicleId);
        if (!before || !text(reason)) throw new Error('กรุณาระบุรถและเหตุผลการตั้งกลุ่ม');
        const after = { ...before, type };
        return commit('vehicle.classify', vehicleId, before, { ...after, reason: text(reason) }, next => { next.vehicles = next.vehicles.map(v => v.id === vehicleId ? after : v); });
      }
    };
  }
  return { KEY, seed, open };
});
