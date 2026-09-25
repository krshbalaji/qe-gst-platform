function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * columns: [{ key, label }] -- key may be a dotted path like 'totals.igst'
 * rows: array of plain objects
 */
function toCsv(rows, columns) {
  const header = columns.map(c => csvCell(c.label)).join(',');
  const lines = rows.map(row =>
    columns.map(c => csvCell(getPath(row, c.key))).join(',')
  );
  return [header, ...lines].join('\r\n');
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel on Windows opens UTF-8 (₹ symbol etc.) correctly instead of mangling it
  res.send('\uFEFF' + csv);
}

module.exports = { toCsv, sendCsv };
