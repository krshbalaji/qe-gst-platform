(function () {
  const gstinInput = document.getElementById('partyGstin');
  const stateSelect = document.getElementById('partyState');
  const regCheckbox = document.getElementById('isRegistered');
  if (!gstinInput || !stateSelect || !regCheckbox) return;
  gstinInput.addEventListener('input', function () {
    this.value = this.value.toUpperCase();
    const v = this.value;
    if (/^[0-9]{2}$/.test(v.slice(0, 2))) {
      stateSelect.value = v.slice(0, 2);
    }
    regCheckbox.checked = v.length === 15;
  });
})();
