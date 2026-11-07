(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InspectionModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const version = 'daily-v2';
  const sections = [
    ['พนักงานขับรถ', ['สมุดประจำรถ', 'ตรวจวัดระดับแอลกอฮอล์ในลมหายใจ', 'การแต่งกาย', 'ชั่วโมงการทำงาน']],
    ['เครื่องยนต์และมาตรวัด', ['สภาพเครื่องยนต์และมลภาวะ', 'ระบบส่งกำลังและเกียร์', 'ระดับน้ำมันเครื่องและน้ำหล่อเย็น', 'ไฟเตือนที่แผงหน้าปัด']],
    ['ตัวถังและประตู', ['ความมั่นคงแข็งแรงของตัวถัง', 'ประตูทางขึ้นลงเปิดปิดปกติ', 'ประตูทางออกฉุกเฉินเปิดได้จากด้านใน']],
    ['ไฟด้านหน้าและแตร', ['ไฟหรี่หน้า', 'ไฟสูงและไฟต่ำหน้า', 'ไฟเลี้ยวซ้ายขวาหน้า', 'ไฟหลังคาด้านหน้า', 'แตร']],
    ['ไฟด้านหลัง', ['ไฟเลี้ยวซ้ายขวาหลัง', 'ไฟหลังคาด้านหลัง', 'ไฟส่องป้ายทะเบียน', 'ไฟเบรก', 'ไฟถอย', 'ไฟหรี่หลัง']],
    ['ที่นั่งและอุปกรณ์ความปลอดภัย', ['ที่นั่งผู้โดยสารยึดติดมั่นคง ไม่ชำรุด', 'เข็มขัดนิรภัย', 'ค้อนทุบกระจก', 'ถังดับเพลิง', 'ระบบ GPS พร้อมใช้งาน', 'ติดตั้งระบบ GPS Tracking', 'ไฟประตูฉุกเฉิน', 'กล้องถอยหลัง', 'ที่นอนพนักงานขับรถ']],
    ['ไฟภายในและระบบแอร์', ['ไฟหรี่ภายใน', 'ไฟทางเดิน', 'ไฟชั้นวางของ', 'ไฟห้องน้ำ', 'ระบบแอร์', 'ปล่องแอร์', 'พัดลมตัวดูด']],
    ['ยางและกระจก', ['ร่องดอกยางลึกไม่น้อยกว่า 1.6 มม. (ตามแบบตรวจ)', 'ยางไม่มีรอยฉีกขาด บวม นูน', 'แรงดันลมยางอยู่ในระดับมาตรฐาน', 'กระจกหน้า หลัง และหน้าต่างไม่แตกร้าว', 'กระจกมองหลังและกระจกมองข้าง']],
    ['ห้องน้ำ', ['ความสะอาดห้องน้ำ', 'ความหอม', 'กระดาษชำระ', 'ระบบฉุกเฉินห้องน้ำ', 'ไฟห้องน้ำและไฟกริ่ง', 'สุขภัณฑ์', 'กลอนประตู', 'ตะกร้าใส่ขยะ']],
    ['อุปกรณ์ให้บริการภายใน', ['ตลับวางแก้ว', 'ตะแกรงหลังเบาะ', 'ที่พักเท้า', 'เข็มขัดนิรภัยทุกที่นั่ง', 'ค้อนทุบกระจกตามชั้นรถ', 'ถังดับเพลิงตามชั้นรถ', 'กระติกน้ำร้อนและถังน้ำแข็ง', 'ที่พักแขน', 'ช่องชาร์จ USB', 'วิทยุสื่อสาร', 'ชุดเครื่องเสียงและไมค์ลอย', 'กล่องปฐมพยาบาล', 'ความสะอาดภายในรถ', 'จดบันทึกสมุดประจำรถ']],
    ['สภาพภายนอกและเบรก', ['ยางทุกเส้นและทุกเพลา', 'เบรกเพลาหน้า เพลาขับเคลื่อน และล้อประคอง', 'ระบบเบรก ABS']]
  ];
  const optionalLabels = new Set(['กล้องถอยหลัง', 'ที่นอนพนักงานขับรถ', 'ไฟห้องน้ำ', 'ปล่องแอร์', 'พัดลมตัวดูด', 'กระติกน้ำร้อนและถังน้ำแข็ง']);
  const legacyTemplate = sections.flatMap(([group, labels], groupIndex) => labels.map((label, index) => ({
    id: `g${groupIndex + 1}-${index + 1}`, group, label,
    optional: group === 'ห้องน้ำ' || optionalLabels.has(label),
    count: /ค้อนทุบกระจก|ถังดับเพลิง/.test(label)
  })));
  // Stable IDs and the original template preserve answers in saved v1 inspections.
  const removed = new Set(['g6-6', 'g7-4', 'g10-4', 'g10-5', 'g10-6', 'g10-14', 'g11-1']);
  const labels = {
    'g1-1': 'มีสมุดประจำรถและจดบันทึกครบถ้วน',
    'g6-2': 'เข็มขัดนิรภัยทุกที่นั่งครบและพร้อมใช้งาน',
    'g6-3': 'ค้อนทุบกระจกครบตามตำแหน่งทุกชั้นรถและพร้อมใช้งาน',
    'g6-4': 'ถังดับเพลิงครบตามตำแหน่งทุกชั้นรถและพร้อมใช้งาน',
    'g6-5': 'ติดตั้ง GPS Tracking และระบบพร้อมใช้งาน',
    'g8-1': 'ยางทุกเส้นทุกเพลา: ร่องดอกยางลึกไม่น้อยกว่า 1.6 มม. (ตามแบบตรวจ)',
    'g8-2': 'ยางทุกเส้นทุกเพลา: ไม่มีรอยฉีกขาด บวม นูน',
    'g8-3': 'ยางทุกเส้นทุกเพลา: แรงดันลมอยู่ในระดับมาตรฐาน',
    'g9-5': 'ไฟส่องสว่างห้องน้ำและไฟกริ่งพร้อมใช้งาน'
  };
  const template = legacyTemplate.filter(item => !removed.has(item.id)).map(item => ({ ...item, label: labels[item.id] || item.label }));
  function getTemplate(templateVersion = version) {
    if (templateVersion === 'daily-v1') return legacyTemplate;
    if (templateVersion === version) return template;
    throw new Error('รุ่นแบบตรวจไม่ถูกต้อง กรุณาโหลดหน้าใหม่');
  }
  function normalize(input, submit = false) {
    const templateVersion = input.templateVersion || version;
    const activeTemplate = getTemplate(templateVersion);
    const text = (value, limit = 500) => String(value || '').trim().slice(0, limit);
    const answers = {};
    for (const item of activeTemplate) {
      const answer = input.answers?.[item.id] || {};
      const status = ['pass', 'fail', 'na'].includes(answer.status) ? answer.status : '';
      if (status === 'na' && !item.optional) throw new Error(`ไม่สามารถข้าม: ${item.label}`);
      const note = text(answer.note);
      const count = answer.count === '' || answer.count == null ? null : Number(answer.count);
      if (item.count && count !== null && (!Number.isInteger(count) || count < 0 || count > 1000)) throw new Error(`จำนวนไม่ถูกต้อง: ${item.label}`);
      if (submit && !status) throw new Error(`ยังไม่ได้ตรวจ: ${item.label}`);
      if (submit && status === 'fail' && !note) throw new Error(`กรุณาระบุปัญหา: ${item.label}`);
      if (submit && item.count && status !== 'na' && count === null) throw new Error(`กรุณาระบุจำนวน: ${item.label}`);
      answers[item.id] = { status, note, count: item.count ? count : null };
    }
    const record = { templateVersion, template: activeTemplate, answers,
      plate: text(input.plate, 100), inspectedAt: text(input.inspectedAt, 40), route: text(input.route, 300),
      driver1: text(input.driver1, 150), driver2: text(input.driver2, 150), license1: text(input.license1, 100), license2: text(input.license2, 100),
      assistant: text(input.assistant, 150), inspector: text(input.inspector, 150), supervisor: text(input.supervisor, 150), notes: text(input.notes, 2000),
      odometer: input.odometer === '' || input.odometer == null ? null : Number(input.odometer)
    };
    if (record.odometer !== null && (!Number.isFinite(record.odometer) || record.odometer < 0)) throw new Error('เลขไมล์ไม่ถูกต้อง');
    if (record.inspectedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(record.inspectedAt) || !Number.isFinite(Date.parse(record.inspectedAt)))) throw new Error('วันเวลาตรวจไม่ถูกต้อง');
    if (submit && (!record.plate || !record.inspectedAt || !record.driver1 || !record.inspector || !record.route)) throw new Error('กรุณาระบุทะเบียน วันเวลา เส้นทาง คนขับ และเจ้าหน้าที่ตรวจ');
    return record;
  }
  function summary(record) {
    const values = Object.values(record.answers || {});
    return { total: (record.template || getTemplate(record.templateVersion)).length, checked: values.filter(answer => answer.status).length,
      failed: values.filter(answer => answer.status === 'fail').length, skipped: values.filter(answer => answer.status === 'na').length };
  }
  function qrPlate(value, plates) {
    let plate = String(value || '').trim();
    try { const url = new URL(plate); plate = url.searchParams.get('inspectionPlate') || ''; } catch (_) {}
    if (!plates.includes(plate)) throw new Error('ไม่พบทะเบียนจาก QR ในทะเบียนรถของระบบ');
    return plate;
  }
  return { version, template, getTemplate, normalize, summary, qrPlate };
});
