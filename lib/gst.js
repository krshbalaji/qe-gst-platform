const { STATE_CODES } = require('./stateCodes');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function isInterState(supplierStateCode, placeOfSupplyStateCode) {
  return String(supplierStateCode) !== String(placeOfSupplyStateCode);
}

/**
 * preset: { id, label, scheme: 'regular' | 'composition' | 'exempt', rate }
 *   - regular: rate is the total GST% (e.g. 18). Split into CGST+SGST (intra) or IGST (inter).
 *   - composition: no tax is charged to the customer (Bill of Supply). Composition tax is
 *     informational/for the dealer's own liability only, tracked separately, not on the invoice.
 *   - exempt: 0%, no tax lines.
 */
function calcLine({ qty, rate, preset, interState }) {
  qty = Number(qty) || 0;
  rate = Number(rate) || 0;
  const taxableValue = round2(qty * rate);
  let cgst = 0, sgst = 0, igst = 0;

  if (preset && preset.scheme === 'regular' && preset.rate > 0) {
    if (interState) {
      igst = round2((taxableValue * preset.rate) / 100);
    } else {
      cgst = round2((taxableValue * preset.rate) / 2 / 100);
      sgst = round2((taxableValue * preset.rate) / 2 / 100);
    }
  }
  // composition & exempt/nil -> no tax lines on the invoice by design

  const total = round2(taxableValue + cgst + sgst + igst);
  return { taxableValue, cgst, sgst, igst, total };
}

function sumTotals(lineItems) {
  return lineItems.reduce(
    (acc, li) => ({
      taxableValue: round2(acc.taxableValue + li.taxableValue),
      cgst: round2(acc.cgst + li.cgst),
      sgst: round2(acc.sgst + li.sgst),
      igst: round2(acc.igst + li.igst),
      total: round2(acc.total + li.total)
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, total: 0 }
  );
}

// Simplified HSN-digit requirement slabs (for demo validation; verify current CBIC notification in production)
function hsnDigitsRequired(annualAggregateTurnover) {
  const t = Number(annualAggregateTurnover) || 0;
  if (t <= 5e7) return 4;   // up to Rs. 5 crore
  return 6;                  // above Rs. 5 crore
}

// e-Invoicing applicability threshold used for the dashboard warning (per spec: Rs. 5 crore AATO)
const EINVOICE_AATO_THRESHOLD = 5e7;
// 30-day IRN reporting-window rule applies at/above this AATO (per spec: Rs. 10 crore)
const EINVOICE_30DAY_WINDOW_THRESHOLD = 10e7;

/**
 * ITC set-off order (simplified per Rule 88A / CGST Act s.49):
 *   - IGST credit may be used against IGST, then CGST, then SGST liability, in that order.
 *   - CGST credit may only be used against CGST liability, then leftover against IGST liability.
 *   - SGST credit may only be used against SGST liability, then leftover against IGST liability.
 *   - CGST credit can NEVER be used against SGST liability, or vice versa.
 * `liability` and `itcClaimed` are { igst, cgst, sgst }. Returns net cash payable per head
 * and the closing (unutilized) ITC balance per head.
 */
function computeItcSetOff({ liability, itcClaimed }) {
  let creditIgst = Number(itcClaimed.igst) || 0;
  let creditCgst = Number(itcClaimed.cgst) || 0;
  let creditSgst = Number(itcClaimed.sgst) || 0;
  let liabIgst = Number(liability.igst) || 0;
  let liabCgst = Number(liability.cgst) || 0;
  let liabSgst = Number(liability.sgst) || 0;

  const setOff = { igstFromIgst: 0, igstFromCgst: 0, igstFromSgst: 0, cgstFromCgst: 0, cgstFromIgst: 0, sgstFromSgst: 0, sgstFromIgst: 0 };

  setOff.igstFromIgst = Math.min(liabIgst, creditIgst); creditIgst -= setOff.igstFromIgst; liabIgst -= setOff.igstFromIgst;
  setOff.igstFromCgst = Math.min(liabIgst, creditCgst); creditCgst -= setOff.igstFromCgst; liabIgst -= setOff.igstFromCgst;
  setOff.igstFromSgst = Math.min(liabIgst, creditSgst); creditSgst -= setOff.igstFromSgst; liabIgst -= setOff.igstFromSgst;

  setOff.cgstFromCgst = Math.min(liabCgst, creditCgst); creditCgst -= setOff.cgstFromCgst; liabCgst -= setOff.cgstFromCgst;
  setOff.cgstFromIgst = Math.min(liabCgst, creditIgst); creditIgst -= setOff.cgstFromIgst; liabCgst -= setOff.cgstFromIgst;

  setOff.sgstFromSgst = Math.min(liabSgst, creditSgst); creditSgst -= setOff.sgstFromSgst; liabSgst -= setOff.sgstFromSgst;
  setOff.sgstFromIgst = Math.min(liabSgst, creditIgst); creditIgst -= setOff.sgstFromIgst; liabSgst -= setOff.sgstFromIgst;

  return {
    netPayable: { igst: round2(liabIgst), cgst: round2(liabCgst), sgst: round2(liabSgst) },
    itcClosingBalance: { igst: round2(creditIgst), cgst: round2(creditCgst), sgst: round2(creditSgst) },
    setOff
  };
}

module.exports = {
  round2,
  isInterState,
  calcLine,
  sumTotals,
  hsnDigitsRequired,
  computeItcSetOff,
  EINVOICE_AATO_THRESHOLD,
  EINVOICE_30DAY_WINDOW_THRESHOLD,
  STATE_CODES
};
