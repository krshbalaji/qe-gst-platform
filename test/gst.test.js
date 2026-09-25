const test = require('node:test');
const assert = require('node:assert/strict');
const { calcLine, sumTotals, isInterState, hsnDigitsRequired, computeItcSetOff, round2 } = require('../lib/gst');

test('isInterState detects intra vs inter correctly', () => {
  assert.equal(isInterState('33', '33'), false);
  assert.equal(isInterState('33', '29'), true);
  assert.equal(isInterState(33, '33'), false); // loose types should still compare equal
});

test('calcLine: regular intra-state splits CGST/SGST evenly', () => {
  const preset = { scheme: 'regular', rate: 18 };
  const r = calcLine({ qty: 10, rate: 100, preset, interState: false });
  assert.equal(r.taxableValue, 1000);
  assert.equal(r.cgst, 90);
  assert.equal(r.sgst, 90);
  assert.equal(r.igst, 0);
  assert.equal(r.total, 1180);
});

test('calcLine: regular inter-state charges IGST only', () => {
  const preset = { scheme: 'regular', rate: 18 };
  const r = calcLine({ qty: 10, rate: 100, preset, interState: true });
  assert.equal(r.igst, 180);
  assert.equal(r.cgst, 0);
  assert.equal(r.sgst, 0);
  assert.equal(r.total, 1180);
});

test('calcLine: composition scheme never charges tax on the invoice', () => {
  const preset = { scheme: 'composition', rate: 1 };
  const r = calcLine({ qty: 10, rate: 100, preset, interState: false });
  assert.equal(r.cgst, 0);
  assert.equal(r.sgst, 0);
  assert.equal(r.igst, 0);
  assert.equal(r.total, 1000);
});

test('calcLine: exempt scheme never charges tax regardless of inter/intra', () => {
  const preset = { scheme: 'exempt', rate: 0 };
  assert.equal(calcLine({ qty: 5, rate: 60, preset, interState: false }).total, 300);
  assert.equal(calcLine({ qty: 5, rate: 60, preset, interState: true }).total, 300);
});

test('calcLine: no preset at all behaves like exempt (defensive default)', () => {
  const r = calcLine({ qty: 2, rate: 50, preset: null, interState: false });
  assert.equal(r.total, 100);
  assert.equal(r.cgst, 0);
});

test('sumTotals aggregates multiple lines correctly', () => {
  const lines = [
    { taxableValue: 100, cgst: 9, sgst: 9, igst: 0, total: 118 },
    { taxableValue: 200, cgst: 0, sgst: 0, igst: 36, total: 236 }
  ];
  const t = sumTotals(lines);
  assert.equal(t.taxableValue, 300);
  assert.equal(t.cgst, 9);
  assert.equal(t.sgst, 9);
  assert.equal(t.igst, 36);
  assert.equal(t.total, 354);
});

test('hsnDigitsRequired: 4 digits at/under 5cr, 6 digits above', () => {
  assert.equal(hsnDigitsRequired(0), 4);
  assert.equal(hsnDigitsRequired(5e7), 4);
  assert.equal(hsnDigitsRequired(5e7 + 1), 6);
  assert.equal(hsnDigitsRequired(20e7), 6);
});

test('computeItcSetOff: simple case, enough of each credit to cover its own liability', () => {
  const { netPayable, itcClosingBalance } = computeItcSetOff({
    liability: { igst: 100, cgst: 50, sgst: 50 },
    itcClaimed: { igst: 100, cgst: 50, sgst: 50 }
  });
  assert.deepEqual(netPayable, { igst: 0, cgst: 0, sgst: 0 });
  assert.deepEqual(itcClosingBalance, { igst: 0, cgst: 0, sgst: 0 });
});

test('computeItcSetOff: IGST credit must be used first, spills into CGST then SGST', () => {
  // No CGST/SGST credit at all; IGST credit covers IGST liability fully, then
  // whatever is left over must be able to cover CGST and SGST liability too.
  const { netPayable, itcClosingBalance } = computeItcSetOff({
    liability: { igst: 50, cgst: 30, sgst: 30 },
    itcClaimed: { igst: 200, cgst: 0, sgst: 0 }
  });
  // 200 IGST credit: 50 to IGST liability, 30 to CGST, 30 to SGST, 90 left over
  assert.deepEqual(netPayable, { igst: 0, cgst: 0, sgst: 0 });
  assert.equal(itcClosingBalance.igst, 90);
});

test('computeItcSetOff: CGST credit can never pay off SGST liability, and vice versa', () => {
  const { netPayable, itcClosingBalance } = computeItcSetOff({
    liability: { igst: 0, cgst: 0, sgst: 100 },
    itcClaimed: { igst: 0, cgst: 100, sgst: 0 } // only CGST credit available
  });
  // CGST credit cannot touch SGST liability -> full SGST liability remains payable in cash
  assert.equal(netPayable.sgst, 100);
  assert.equal(itcClosingBalance.cgst, 100); // the CGST credit sits unused
});

test('computeItcSetOff: CGST liability can fall back on leftover IGST credit', () => {
  const { netPayable, itcClosingBalance } = computeItcSetOff({
    liability: { igst: 0, cgst: 40, sgst: 0 },
    itcClaimed: { igst: 40, cgst: 0, sgst: 0 }
  });
  assert.equal(netPayable.cgst, 0);
  assert.equal(itcClosingBalance.igst, 0);
});

test('round2 rounds to 2 decimal places avoiding float noise', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(10 / 3), 3.33);
});
