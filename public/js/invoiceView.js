(function () {
  const printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.addEventListener('click', () => window.print());

  const cancelIrnForm = document.getElementById('cancelIrnForm');
  if (cancelIrnForm) {
    cancelIrnForm.addEventListener('submit', (e) => {
      if (!confirm('Cancel this IRN? This cannot be undone in a real IRP.')) e.preventDefault();
    });
  }

  const cancelInvoiceForm = document.getElementById('cancelInvoiceForm');
  if (cancelInvoiceForm) {
    cancelInvoiceForm.addEventListener('submit', (e) => {
      const reason = prompt('Reason for cancelling this document (kept for audit trail):');
      if (reason === null) { e.preventDefault(); return; }
      document.getElementById('cancelReasonInput').value = reason;
    });
  }
})();
