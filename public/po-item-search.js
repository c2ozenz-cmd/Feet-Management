(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./po-item-context'));
  else root.POItemSearch = factory(root.POItemContext);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(context) {
  const aliases = [['หัวฉีด', 'injector'], ['คลัตช์', 'คลัช', 'clutch'], ['เบรก', 'เบรค', 'brake']];
  const normalize = value => String(value || '').normalize('NFC').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  function buildRows(pos, items) {
    const headers = new Map(pos.map(po => [po.po_no, po]));
    const totals = new Map();
    items.forEach(item => totals.set(item.po_no, (totals.get(item.po_no) || 0) + Math.round((Number(item.amount) || 0) * 100)));
    return items.flatMap(item => {
      const po = headers.get(item.po_no);
      if (!po) return [];
      const meta = context.decode(item.note);
      const net = (totals.get(po.po_no) || 0) / 100;
      const row = {
        id: item.id, poNo: po.po_no, shopName: po.shop_name || '', issueDate: po.issue_date || '',
        status: po.status || '', plate: meta.plate || po.plate || '',
        refRepairNo: meta.refRepairNo || (po.plate === 'หลายคัน' ? '' : po.ref_repair_no) || '',
        partName: item.part_name || '', note: meta.note, qty: Number(item.qty) || 0, unit: item.unit || '',
        amount: Number(item.amount) || 0, poTotal: Math.round(net * (po.vat_type === 'exclusive' ? 1.07 : 1) * 100) / 100,
        pdfUrl: po.pdf_url || ''
      };
      row.searchText = normalize([row.poNo, row.partName, row.note, row.shopName, row.plate, row.refRepairNo].join(' '));
      return [row];
    }).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.poNo.localeCompare(a.poNo, 'en', { numeric: true }) || Number(a.id) - Number(b.id));
  }
  function search(rows, filter = {}) {
    const terms = normalize(filter.query).split(' ').filter(Boolean).map(term => aliases.find(group => group.includes(term)) || [term]);
    return rows.filter(row => (!filter.from || row.issueDate >= filter.from)
      && (!filter.to || row.issueDate <= filter.to)
      && (!filter.plate || row.plate === filter.plate)
      && (!filter.shopName || row.shopName === filter.shopName)
      && (!filter.status || row.status === filter.status)
      && terms.every(alternatives => alternatives.some(term => row.searchText.includes(term))));
  }
  return { buildRows, search, normalize };
});
