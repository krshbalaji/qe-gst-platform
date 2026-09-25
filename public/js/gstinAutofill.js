(function () {
  const gstinInput = document.getElementById('gstinInput');
  const stateSelect = document.getElementById('stateCode');
  if (!gstinInput || !stateSelect) return;
  gstinInput.addEventListener('input', function () {
    this.value = this.value.toUpperCase();
    const v = this.value;
    if (v.length >= 2 && /^[0-9]{2}$/.test(v.slice(0, 2))) {
      stateSelect.value = v.slice(0, 2);
    }
  });
})();
