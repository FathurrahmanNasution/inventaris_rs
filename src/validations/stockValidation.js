function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function text(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\x00-\x1f\x7f]/.test(value))
    fail(label + ' wajib berupa teks dengan maksimal ' + max + ' karakter.');
  return value.trim();
}
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    fail(label + ' harus tanggal valid YYYY-MM-DD.');
  return value;
}
function quantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('Kuantitas harus bilangan bulat positif maksimal 2147483647.');
  return value;
}
function price(value) {
  const s = String(value);
  if (!['number', 'string'].includes(typeof value) || !/^\d{1,13}(\.\d{1,2})?$/.test(s))
    fail('Harga beli harus angka nonnegatif dengan maksimal dua angka desimal.');
  const [whole, fraction = ''] = s.split('.');
  return whole + '.' + fraction.padEnd(2, '0');
}
function validate(body, type) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Data transaksi tidak valid.');
  const items = type === 'OUT' && body.items === undefined ? [body] : body.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('Isi 1 sampai 100 item transaksi.');
  const result = {
    reference_number: text(body.reference_number, 'Nomor referensi', 100),
    notes: text(body.notes, 'Catatan', 300, true),
    items: items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Item transaksi tidak valid.');
      const entry = { medicine_code: text(item.medicine_code, 'Kode obat', 50), quantity: quantity(item.quantity) };
      return type === 'OUT' ? entry : { ...entry,
        batch_number: text(item.batch_number, 'Nomor batch', 100),
        expired_date: date(item.expired_date, 'Tanggal kedaluwarsa'), unit_price: price(item.unit_price) };
    })
  };
  if (type === 'IN') {
    result.supplier = text(body.supplier, 'Supplier/PBF', 255);
    result.received_date = date(body.received_date, 'Tanggal terima');
    const batches = result.items.map(i => i.batch_number);
    if (new Set(batches).size !== batches.length) fail('Nomor batch duplikat dalam penerimaan.', 409);
  } else {
    result.destination = text(body.destination, 'Unit tujuan', 100);
    const codes = result.items.map(i => i.medicine_code);
    if (new Set(codes).size !== codes.length) fail('Gabungkan kuantitas item dengan kode obat yang sama.');
  }
  return result;
}
function documentId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('ID bukti tidak valid.');
  return value;
}
function limit(value, fallback = 20, max = 500) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > max) fail('Limit tidak valid.');
  return Number(value);
}
module.exports = { fail, text, date, validate, documentId, limit };
