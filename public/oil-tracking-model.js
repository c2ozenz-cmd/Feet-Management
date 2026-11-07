(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OilTrackingModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const groups = {
    bus: { name: 'รถบัสทั่วไป', km: 35000, months: 6 },
    special: { name: 'รถบัสรอบพิเศษ', km: 20000, months: 6 },
    minibus: { name: 'มินิบัส', km: 10000, months: 6 },
    van: { name: 'รถตู้ปรับอากาศ', km: 10000, months: 6 }
  };
  const defaults = { groups, warnKm: 2000, warnDays: 30, staleDays: 30 };
  const statuses = { normal: 'ปกติ', near: 'ใกล้ครบ', due: 'ครบหรือเกินกำหนด', pending: 'รอตั้งต้นข้อมูล', review: 'ข้อมูลต้องตรวจสอบ' };
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('วันที่ไม่ถูกต้อง');
    const d = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error('วันที่ไม่ถูกต้อง');
    return d;
  }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function addMonths(value, months) {
    const d = date(value);
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('รอบเดือนต้องเป็นจำนวนเต็ม 1–120');
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0));
    const result = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), Math.min(d.getUTCDate(), last.getUTCDate())));
    return result.toISOString().slice(0, 10);
  }
  const days = (a, b) => Math.round((date(a) - date(b)) / 86400000);
  const clone = value => JSON.parse(JSON.stringify(value));
  function mileage(value) {
    if (value === '' || (typeof value === 'string' && !value.trim()) || value === null || value === undefined || typeof value === 'boolean') throw new Error('กรุณาระบุเลขไมล์');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) throw new Error('เลขไมล์ต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 100,000,000');
    return n;
  }
  function settings(input) {
    const result = clone(defaults);
    for (const key of Object.keys(groups)) {
      const g = input.groups?.[key];
      if (!g) throw new Error('ตั้งค่ากลุ่มรอบไม่ครบ');
      const km = mileage(g.km), months = Number(g.months);
      if (km < 1 || !Number.isInteger(months) || months < 1 || months > 120) throw new Error('รอบระยะทาง/เดือนต้องมากกว่า 0');
      result.groups[key] = { name: groups[key].name, km, months };
    }
    for (const key of ['warnKm', 'warnDays', 'staleDays']) {
      const n = mileage(input[key]);
      if (key === 'staleDays' && n < 1) throw new Error('อายุข้อมูลไมล์ต้องอย่างน้อย 1 วัน');
      result[key] = n;
    }
    return result;
  }
  function rule(vehicle, config = defaults) {
    const plate = String(vehicle.plate || '').trim().match(/^(\d{2}-\d{4})(?:\s|$)/)?.[1];
    let key = ['30-5115', '30-5145'].includes(plate) ? 'special' : ['30-5456', '30-5455'].includes(plate) ? 'minibus' : vehicle.type;
    if (!['bus', 'minibus', 'van', 'special'].includes(key) || (key === 'special' && !['30-5115', '30-5145'].includes(plate))) return null;
    return { key, ...config.groups[key] };
  }
  function effective(events) {
    const superseded = new Set(events.map(e => e.supersedes).filter(Boolean));
    return events.filter(e => !superseded.has(e.id));
  }
  const latest = events => [...events].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.sequence || 0) - (a.sequence || 0))[0];
  function validateTimeline(services, readings, asOf) {
    date(asOf);
    const all = [...services, ...readings];
    for (const item of all) {
      date(item.date); mileage(item.odometer);
      if (item.date > asOf) throw new Error('วันที่อ่านไมล์หรือเปลี่ยนถ่ายอยู่ในอนาคต');
    }
    all.sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer);
    for (let i = 1; i < all.length; i++) if (all[i].odometer < all[i - 1].odometer) throw new Error('เลขไมล์ลดลงหรือไม่สัมพันธ์กับลำดับวันที่ กรุณาตรวจสอบ');
  }
  function evaluate(vehicle, services, readings, config = defaults, asOf = today()) {
    let r, oil, reading;
    const result = { rule: null, oil: null, reading: null, dueKm: null, dueDate: null, remainingKm: null, remainingDays: null };
    const finish = (status, reason) => ({ ...result, status, reason });
    try {
      config = settings(config); date(asOf);
      r = rule(vehicle, config); oil = latest(effective(services)); reading = latest(effective(readings));
      Object.assign(result, { rule:r,oil,reading });
      validateTimeline(effective(services), effective(readings), asOf);
      if (effective(services).some(e => !['S', 'M', 'S2', 'L'].includes(e.program))) throw new Error('โปรแกรมเปลี่ยนถ่ายไม่ถูกต้อง');
      if (oil && reading && (reading.date < oil.date || reading.odometer < oil.odometer)) throw new Error('ไมล์ปัจจุบันเก่ากว่าหรือน้อยกว่าไมล์เปลี่ยนถ่ายล่าสุด');
      if (reading && days(asOf, reading.date) > config.staleDays) throw new Error(`ข้อมูลไมล์เก่ากว่า ${config.staleDays} วัน กรุณาอ่านไมล์ใหม่`);
    } catch (error) { return finish('review', error.message); }
    if (!r) return finish('pending', 'ยังไม่ได้ระบุประเภทรถ/กลุ่มรอบ ห้ามใช้รอบรถบัสทั่วไปแทน');
    if (!oil || !reading) return finish('pending', !oil ? 'ยังไม่มีวันและไมล์เปลี่ยนถ่ายจริง' : 'ยังไม่มีไมล์ปัจจุบันและวันที่อ่าน');
    result.dueKm = Number(oil.odometer) + r.km;
    result.dueDate = addMonths(oil.date, r.months);
    result.remainingKm = result.dueKm - reading.odometer;
    result.remainingDays = days(result.dueDate, asOf);
    if (result.remainingKm <= 0 || result.remainingDays <= 0) return finish('due', 'ครบกำหนดระยะทางหรือวันที่แล้ว');
    if (result.remainingKm <= config.warnKm || result.remainingDays <= config.warnDays) return finish('near', 'ระยะทางหรือวันคงเหลืออยู่ในช่วงเตือน');
    return finish('normal', 'ข้อมูลครบและยังไม่ถึงช่วงเตือน');
  }
  return { groups, defaults, statuses, date, today, addMonths, days, mileage, settings, rule, effective, latest, validateTimeline, evaluate, clone };
});
