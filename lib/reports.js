const { round2 } = require('./gst');

function invoicesFor(db, { companyId, gstinId, period, includeCancelled = false }) {
  return db.invoices.filter(inv =>
    inv.companyId === companyId &&
    (includeCancelled || inv.status !== 'cancelled') &&
    (!gstinId || inv.gstinId === Number(gstinId)) &&
    (!period || inv.period === period)
  );
}

function partyById(db, id) {
  return db.parties.find(p => p.id === id);
}

/**
 * Builds a simplified GSTR-1 auto-draft: B2B (4A), B2CS, CDNR (9B), and HSN summary (12).
 */
function buildGstr1Draft(db, ctx) {
  const invoices = invoicesFor(db, ctx);
  const b2b = [];
  const b2cs = [];
  const cdnr = [];
  const hsnMap = new Map(); // key: hsn|unit|rate

  for (const inv of invoices) {
    const party = partyById(db, inv.partyId);
    const isCreditDebit = inv.type === 'credit_note' || inv.type === 'debit_note';

    // Group this invoice's line items by applicable GST rate for the 4A/9B "rate-wise" rows
    const byRate = new Map();
    for (const li of inv.lineItems) {
      const rateKey = `${li.igstRate || 0}|${li.cgstRate || 0}|${li.sgstRate || 0}`;
      if (!byRate.has(rateKey)) byRate.set(rateKey, { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, igstRate: li.igstRate || 0, cgstRate: li.cgstRate || 0, sgstRate: li.sgstRate || 0 });
      const b = byRate.get(rateKey);
      b.taxableValue = round2(b.taxableValue + li.taxableValue);
      b.igst = round2(b.igst + li.igst);
      b.cgst = round2(b.cgst + li.cgst);
      b.sgst = round2(b.sgst + li.sgst);

      // HSN summary (table 12) — aggregate regardless of registration status
      const hKey = `${li.hsnSac}|${li.unit}|${li.igstRate || 0}|${li.cgstRate || 0}|${li.sgstRate || 0}`;
      if (!hsnMap.has(hKey)) {
        hsnMap.set(hKey, { hsnSac: li.hsnSac, unit: li.unit, description: li.description, qty: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });
      }
      const h = hsnMap.get(hKey);
      h.qty = round2(h.qty + Number(li.qty));
      h.taxableValue = round2(h.taxableValue + li.taxableValue);
      h.igst = round2(h.igst + li.igst);
      h.cgst = round2(h.cgst + li.cgst);
      h.sgst = round2(h.sgst + li.sgst);
    }

    for (const [, b] of byRate) {
      const row = {
        invoiceNo: inv.invoiceNo, date: inv.date, placeOfSupply: inv.placeOfSupplyStateCode,
        partyName: party ? party.name : '(unknown)', partyGstin: party ? party.gstin : '',
        reverseCharge: inv.reverseCharge,
        taxableValue: b.taxableValue, igst: b.igst, cgst: b.cgst, sgst: b.sgst,
        invoiceValue: round2(b.taxableValue + b.igst + b.cgst + b.sgst),
        rate: (b.igstRate || (b.cgstRate * 2)) || 0,
        einvoiceStatus: inv.einvoice ? (inv.einvoice.cancelled ? 'cancelled' : 'generated') : 'not generated'
      };
      if (isCreditDebit && party && party.isRegistered) {
        cdnr.push({ ...row, noteType: inv.type === 'credit_note' ? 'Credit Note' : 'Debit Note' });
      } else if (party && party.isRegistered && party.gstin) {
        b2b.push(row);
      } else if (!isCreditDebit) {
        b2cs.push({ ...row, supplyState: party ? party.stateCode : inv.placeOfSupplyStateCode });
      }
    }
  }

  const hsnSummary = Array.from(hsnMap.values()).map(h => ({
    ...h, totalValue: round2(h.taxableValue + h.igst + h.cgst + h.sgst)
  }));

  const totals = {
    taxableValue: round2([...b2b, ...b2cs].reduce((s, r) => s + r.taxableValue, 0) - cdnr.reduce((s, r) => s + r.taxableValue, 0)),
    igst: round2([...b2b, ...b2cs].reduce((s, r) => s + r.igst, 0) - cdnr.reduce((s, r) => s + r.igst, 0)),
    cgst: round2([...b2b, ...b2cs].reduce((s, r) => s + r.cgst, 0) - cdnr.reduce((s, r) => s + r.cgst, 0)),
    sgst: round2([...b2b, ...b2cs].reduce((s, r) => s + r.sgst, 0) - cdnr.reduce((s, r) => s + r.sgst, 0))
  };

  return { b2b, b2cs, cdnr, hsnSummary, totals, invoiceCount: invoices.length };
}

function buildSalesRegister(db, ctx) {
  const invoices = invoicesFor(db, { ...ctx, includeCancelled: true }).slice().sort((a, b) => a.invoiceNo.localeCompare(b.invoiceNo));
  return invoices.map(inv => {
    const party = partyById(db, inv.partyId);
    return {
      id: inv.id, invoiceNo: inv.invoiceNo, date: inv.date, type: inv.type,
      partyName: party ? party.name : '(unknown)', interState: inv.interState,
      taxableValue: inv.totals.taxableValue, cgst: inv.totals.cgst, sgst: inv.totals.sgst, igst: inv.totals.igst,
      total: inv.totals.total, einvoice: !!inv.einvoice && !inv.einvoice.cancelled,
      status: inv.status || 'finalized', cancelled: inv.status === 'cancelled'
    };
  });
}

function paginate(rows, page, pageSize) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.max(1, Number(pageSize) || 25);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(page, totalPages);
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), page, pageSize, total, totalPages };
}

function buildPartyWise(db, ctx) {
  const invoices = invoicesFor(db, ctx);
  const map = new Map();
  for (const inv of invoices) {
    const party = partyById(db, inv.partyId);
    const key = inv.partyId;
    if (!map.has(key)) map.set(key, { partyName: party ? party.name : '(unknown)', gstin: party ? party.gstin : '', invoiceCount: 0, taxableValue: 0, tax: 0, total: 0 });
    const m = map.get(key);
    m.invoiceCount += 1;
    m.taxableValue = round2(m.taxableValue + inv.totals.taxableValue);
    m.tax = round2(m.tax + inv.totals.cgst + inv.totals.sgst + inv.totals.igst);
    m.total = round2(m.total + inv.totals.total);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

/** GSTR-1 vs E-Invoice (IRP) reconciliation — purely from data already in the system. */
function buildEinvoiceReconciliation(db, ctx) {
  const invoices = invoicesFor(db, ctx).filter(inv => inv.type !== 'bill_of_supply');
  const buckets = { matched: [], missingIrn: [], cancelledIrn: [] };
  for (const inv of invoices) {
    const row = { id: inv.id, invoiceNo: inv.invoiceNo, date: inv.date, total: inv.totals.total };
    if (!inv.einvoice) buckets.missingIrn.push(row);
    else if (inv.einvoice.cancelled) buckets.cancelledIrn.push({ ...row, irn: inv.einvoice.irn });
    else buckets.matched.push({ ...row, irn: inv.einvoice.irn, ackNo: inv.einvoice.ackNo });
  }
  return buckets;
}

/** GSTR-2B vs Purchase Register reconciliation. */
function buildPurchaseReconciliation(db, { companyId, period }) {
  const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId && p.period === period);
  const gstr2bLines = db.gstr2b.filter(g => g.companyId === companyId && g.period === period);

  const byInvoiceNo = new Map(purchases.map(p => [p.invoiceNo, p]));
  const seen = new Set();
  const matched = [], valueMismatch = [], missingInPurchaseRegister = [];

  for (const g of gstr2bLines) {
    const p = byInvoiceNo.get(g.invoiceNo);
    if (!p) {
      missingInPurchaseRegister.push(g); // present in 2B, not booked in purchase register -> ITC risk if claimed
      continue;
    }
    seen.add(p.invoiceNo);
    const diff = Math.abs(round2(p.total - g.total));
    if (diff > 0.5) valueMismatch.push({ invoiceNo: g.invoiceNo, vendor: g.vendorName, purchaseRegisterValue: p.total, gstr2bValue: g.total, diff });
    else matched.push({ invoiceNo: g.invoiceNo, vendor: g.vendorName, value: g.total });
  }
  const missingInGstr2b = purchases.filter(p => !seen.has(p.invoiceNo));

  return { matched, valueMismatch, missingInPurchaseRegister, missingInGstr2b, hasGstr2b: gstr2bLines.length > 0 };
}

module.exports = { buildGstr1Draft, buildSalesRegister, buildPartyWise, buildEinvoiceReconciliation, buildPurchaseReconciliation, invoicesFor, paginate };
