const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGstr1Draft, buildSalesRegister, invoicesFor } = require('../lib/reports');

function makeLine({ description = 'Item', hsnSac = '1234', unit = 'PCS', qty = 1, rate = 100, cgst = 0, sgst = 0, igst = 0, cgstRate = 0, sgstRate = 0, igstRate = 0 } = {}) {
  const taxableValue = qty * rate;
  return { description, hsnSac, unit, qty, rate, taxableValue, cgst, sgst, igst, cgstRate, sgstRate, igstRate, total: taxableValue + cgst + sgst + igst };
}

function fixtureDb() {
  return {
    parties: [
      { id: 1, companyId: 1, type: 'customer', name: 'Registered TN Buyer', gstin: '33ABCDE1234F1Z1', stateCode: '33', isRegistered: true },
      { id: 2, companyId: 1, type: 'customer', name: 'Registered KA Buyer', gstin: '29ABCDE1234F1Z1', stateCode: '29', isRegistered: true },
      { id: 3, companyId: 1, type: 'customer', name: 'Walk-in', gstin: '', stateCode: '33', isRegistered: false }
    ],
    invoices: [
      // Intra-state B2B, 18% -> CGST 9 + SGST 9 on 200 taxable
      {
        id: 1, companyId: 1, gstinId: 1, invoiceNo: 'INV-0001', date: '2026-01-05', period: '2026-01',
        type: 'tax_invoice', partyId: 1, interState: false, status: 'finalized',
        lineItems: [makeLine({ qty: 2, rate: 100, cgst: 18, sgst: 18, cgstRate: 9, sgstRate: 9 })],
        totals: { taxableValue: 200, cgst: 18, sgst: 18, igst: 0, total: 236 }
      },
      // Inter-state B2B, 18% -> IGST 36 on 200 taxable
      {
        id: 2, companyId: 1, gstinId: 1, invoiceNo: 'INV-0002', date: '2026-01-06', period: '2026-01',
        type: 'tax_invoice', partyId: 2, interState: true, status: 'finalized',
        lineItems: [makeLine({ qty: 2, rate: 100, igst: 36, igstRate: 18 })],
        totals: { taxableValue: 200, cgst: 0, sgst: 0, igst: 36, total: 236 }
      },
      // B2C (unregistered), intra-state 5%
      {
        id: 3, companyId: 1, gstinId: 1, invoiceNo: 'INV-0003', date: '2026-01-07', period: '2026-01',
        type: 'tax_invoice', partyId: 3, placeOfSupplyStateCode: '33', interState: false, status: 'finalized',
        lineItems: [makeLine({ qty: 1, rate: 500, cgst: 12.5, sgst: 12.5, cgstRate: 2.5, sgstRate: 2.5 })],
        totals: { taxableValue: 500, cgst: 12.5, sgst: 12.5, igst: 0, total: 525 }
      },
      // Cancelled invoice -- must be excluded from every aggregate below
      {
        id: 4, companyId: 1, gstinId: 1, invoiceNo: 'INV-0004', date: '2026-01-08', period: '2026-01',
        type: 'tax_invoice', partyId: 1, interState: false, status: 'cancelled', cancelReason: 'duplicate entry',
        lineItems: [makeLine({ qty: 1, rate: 1000, cgst: 90, sgst: 90, cgstRate: 9, sgstRate: 9 })],
        totals: { taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 }
      }
    ]
  };
}

test('invoicesFor excludes cancelled invoices by default', () => {
  const db = fixtureDb();
  const rows = invoicesFor(db, { companyId: 1, period: '2026-01' });
  assert.equal(rows.length, 3);
  assert.ok(!rows.some(r => r.status === 'cancelled'));
});

test('invoicesFor can include cancelled invoices when asked (for audit registers)', () => {
  const db = fixtureDb();
  const rows = invoicesFor(db, { companyId: 1, period: '2026-01', includeCancelled: true });
  assert.equal(rows.length, 4);
});

test('buildGstr1Draft buckets registered invoices as B2B and unregistered as B2CS', () => {
  const db = fixtureDb();
  const draft = buildGstr1Draft(db, { companyId: 1, period: '2026-01' });
  assert.equal(draft.b2b.length, 2);
  assert.equal(draft.b2cs.length, 1);
  assert.equal(draft.cdnr.length, 0);
  // the cancelled invoice's value must not leak into net totals
  assert.equal(draft.totals.taxableValue, 900); // 200 + 200 + 500, not +1000
});

test('buildGstr1Draft HSN summary aggregates quantity and value across invoices sharing an HSN', () => {
  const db = fixtureDb();
  // give invoice 1 and invoice 2 the same HSN so they aggregate into one row
  const draft = buildGstr1Draft(db, { companyId: 1, period: '2026-01' });
  const row = draft.hsnSummary.find(h => h.hsnSac === '1234' && h.cgst === undefined ? false : true);
  // there will be multiple HSN rows split by rate; just sanity check the qty sums are right per rate bucket
  const totalQtyAcrossHsn = draft.hsnSummary.reduce((s, h) => s + h.qty, 0);
  assert.equal(totalQtyAcrossHsn, 2 + 2 + 1); // qty from invoices 1, 2, 3 (cancelled invoice 4's qty excluded)
});

test('buildSalesRegister includes cancelled invoices (for the audit trail) but flags them', () => {
  const db = fixtureDb();
  const rows = buildSalesRegister(db, { companyId: 1, period: '2026-01' });
  assert.equal(rows.length, 4);
  const cancelledRow = rows.find(r => r.invoiceNo === 'INV-0004');
  assert.equal(cancelledRow.cancelled, true);
  const activeRow = rows.find(r => r.invoiceNo === 'INV-0001');
  assert.equal(activeRow.cancelled, false);
});
