(function () {
  function num(el) { return parseFloat(el && el.value) || 0; }
  function num2(el) { return parseFloat(el && el.dataset.value) || 0; }
  function fmt(n) { return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

  function setOff(liability, credit) {
    let creditIgst = credit.igst, creditCgst = credit.cgst, creditSgst = credit.sgst;
    let liabIgst = liability.igst, liabCgst = liability.cgst, liabSgst = liability.sgst;

    const u = { igstFromIgst: 0, igstFromCgst: 0, igstFromSgst: 0, cgstFromCgst: 0, cgstFromIgst: 0, sgstFromSgst: 0, sgstFromIgst: 0 };
    u.igstFromIgst = Math.min(liabIgst, creditIgst); creditIgst -= u.igstFromIgst; liabIgst -= u.igstFromIgst;
    u.igstFromCgst = Math.min(liabIgst, creditCgst); creditCgst -= u.igstFromCgst; liabIgst -= u.igstFromCgst;
    u.igstFromSgst = Math.min(liabIgst, creditSgst); creditSgst -= u.igstFromSgst; liabIgst -= u.igstFromSgst;

    u.cgstFromCgst = Math.min(liabCgst, creditCgst); creditCgst -= u.cgstFromCgst; liabCgst -= u.cgstFromCgst;
    u.cgstFromIgst = Math.min(liabCgst, creditIgst); creditIgst -= u.cgstFromIgst; liabCgst -= u.cgstFromIgst;

    u.sgstFromSgst = Math.min(liabSgst, creditSgst); creditSgst -= u.sgstFromSgst; liabSgst -= u.sgstFromSgst;
    u.sgstFromIgst = Math.min(liabSgst, creditIgst); creditIgst -= u.sgstFromIgst; liabSgst -= u.sgstFromIgst;

    return { netPayable: { igst: liabIgst, cgst: liabCgst, sgst: liabSgst }, closing: { igst: creditIgst, cgst: creditCgst, sgst: creditSgst } };
  }

  function recalc() {
    const liability = {
      igst: num2(document.getElementById('liabIgst')),
      cgst: num2(document.getElementById('liabCgst')),
      sgst: num2(document.getElementById('liabSgst'))
    };
    const credit = {
      igst: num(document.getElementById('claimedIgst')),
      cgst: num(document.getElementById('claimedCgst')),
      sgst: num(document.getElementById('claimedSgst'))
    };
    const { netPayable, closing } = setOff(liability, credit);
    document.getElementById('payIgst').textContent = fmt(netPayable.igst);
    document.getElementById('payCgst').textContent = fmt(netPayable.cgst);
    document.getElementById('paySgst').textContent = fmt(netPayable.sgst);
    document.getElementById('payTotal').textContent = fmt(netPayable.igst + netPayable.cgst + netPayable.sgst);
    document.getElementById('closeIgst').textContent = fmt(closing.igst);
    document.getElementById('closeCgst').textContent = fmt(closing.cgst);
    document.getElementById('closeSgst').textContent = fmt(closing.sgst);
  }

  ['claimedIgst', 'claimedCgst', 'claimedSgst'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalc);
  });
  recalc();
})();
