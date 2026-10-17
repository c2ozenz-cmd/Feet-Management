(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.POItemContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const prefix = '@po-item:v1:';
  function decode(note) {
    if (typeof note === 'string' && note.startsWith(prefix)) {
      try {
        const value = JSON.parse(note.slice(prefix.length));
        if (value && typeof value.note === 'string' && typeof value.plate === 'string' && typeof value.refRepairNo === 'string') return value;
      } catch (_) {}
    }
    return { note: note || '', plate: '', refRepairNo: '' };
  }
  function encode(item) {
    if (!item.plate && !item.refRepairNo) return item.note || '';
    return prefix + JSON.stringify({ note: item.note || '', plate: item.plate || '', refRepairNo: item.refRepairNo || '' });
  }
  function label(item) {
    return [item.plate, item.refRepairNo ? 'Job: ' + item.refRepairNo : ''].filter(Boolean).join(' | ');
  }
  function group(items, po) {
    const groups = new Map();
    items.forEach(item => {
      const context = decode(item.note);
      const plate = context.plate || po.plate || '';
      const job = context.refRepairNo || (po.plate === 'หลายคัน' ? '' : po.ref_repair_no) || '';
      const key = JSON.stringify([plate, job]);
      const row = groups.get(key) || { plate, refRepairNo: job, total: 0 };
      row.total += Math.round((Number(item.amount) || 0) * 100);
      groups.set(key, row);
    });
    return Array.from(groups.values(), row => ({ ...row, total: row.total / 100 }));
  }
  return { decode, encode, label, group };
});
