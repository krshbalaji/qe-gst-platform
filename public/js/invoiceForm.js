(function () {
  const CUSTOM = '__CUSTOM__';
  let ctx = { gstins: [], customers: [], products: [], presets: [], stateCodes: [] };

  const gstinSelect = document.getElementById('gstinId');
  const docTypeSelect = document.getElementById('docType');
  const partySelect = document.getElementById('partyId');
  const posSelect = document.getElementById('placeOfSupplyStateCode');
  const supplyTypeDisplay = document.getElementById('supplyTypeDisplay');
  const body = document.getElementById('lineItemsBody');
  const template = document.getElementById('lineRowTemplate');
  const addLineBtn = document.getElementById('addLineBtn');

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function fmt(n) { return n.toFixed(2); }

  function supplierStateCode() {
    const opt = gstinSelect.options[gstinSelect.selectedIndex];
    return opt ? opt.dataset.state : null;
  }

  function updateSupplyType() {
    const sState = supplierStateCode();
    const pState = posSelect.value;
    if (!sState || !pState) { supplyTypeDisplay.value = '—'; return; }
    supplyTypeDisplay.value = sState === pState ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)';
    recalcAll();
  }

  function populatePartySelect() {
    partySelect.innerHTML = '';
    ctx.customers.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.state = c.stateCode;
      opt.textContent = c.name + (c.gstin ? ' (' + c.gstin + ')' : ' (unregistered)');
      partySelect.appendChild(opt);
    });
    if (ctx.customers.length) {
      posSelect.value = ctx.customers[0].stateCode;
    }
  }

  function populateProductSelect(select) {
    select.innerHTML = '';
    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM;
    customOpt.textContent = '<< CUSTOM ENTRY >>';
    select.appendChild(customOpt);
    ctx.products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.description + ' — ' + p.hsnSac;
      select.appendChild(opt);
    });
  }

  function populatePresetSelect(select) {
    select.innerHTML = '';
    ctx.presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.dataset.scheme = p.scheme;
      opt.dataset.rate = p.rate;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
  }

  function setCustomMode(row, isCustom) {
    const desc = row.querySelector('.description-input');
    const hsn = row.querySelector('.hsn-input');
    const unit = row.querySelector('.unit-input');
    const rate = row.querySelector('.rate-input');
    [desc, hsn, rate].forEach(el => {
      el.readOnly = !isCustom;
      el.classList.toggle('editable', isCustom);
      el.classList.toggle('calc', !isCustom);
    });
    unit.disabled = !isCustom;
  }

  // `prefill` (optional): { description, hsnSac, unit, qty, rate, presetId }
  // Used both for a blank custom row (add-line button) and for pre-populating
  // a credit note from a prior invoice.
  function addLine(prefill) {
    const frag = template.content.cloneNode(true);
    const row = frag.querySelector('.line-row');
    const productSelect = row.querySelector('.product-select');
    const presetSelect = row.querySelector('.preset-select');

    populateProductSelect(productSelect);
    populatePresetSelect(presetSelect);
    setCustomMode(row, true);

    if (prefill) {
      row.querySelector('.description-input').value = prefill.description || '';
      row.querySelector('.hsn-input').value = prefill.hsnSac || '';
      row.querySelector('.unit-input').value = prefill.unit || 'PCS';
      row.querySelector('.qty-input').value = prefill.qty != null ? prefill.qty : 1;
      row.querySelector('.rate-input').value = prefill.rate != null ? prefill.rate : '';
      if (prefill.presetId != null && ctx.presets.some(p => String(p.id) === String(prefill.presetId))) {
        presetSelect.value = prefill.presetId;
      }
    }

    productSelect.addEventListener('change', () => {
      if (productSelect.value === CUSTOM) {
        setCustomMode(row, true);
        row.querySelector('.description-input').value = '';
        row.querySelector('.hsn-input').value = '';
        row.querySelector('.rate-input').value = '';
      } else {
        const p = ctx.products.find(x => String(x.id) === productSelect.value);
        setCustomMode(row, false);
        row.querySelector('.description-input').value = p.description;
        row.querySelector('.hsn-input').value = p.hsnSac;
        row.querySelector('.unit-input').value = p.unit;
        row.querySelector('.rate-input').value = p.rate;
        const preset = ctx.presets.find(pr => pr.label === p.defaultPresetLabel);
        if (preset) presetSelect.value = preset.id;
      }
      recalcRow(row);
    });

    row.querySelectorAll('.qty-input, .rate-input, .preset-select').forEach(el => {
      el.addEventListener('input', () => recalcRow(row));
      el.addEventListener('change', () => recalcRow(row));
    });
    row.querySelector('.remove-line').addEventListener('click', () => { row.remove(); recalcAll(); });

    body.appendChild(row);
    recalcRow(row);
  }

  function recalcRow(row) {
    const qty = num(row.querySelector('.qty-input').value);
    const rate = num(row.querySelector('.rate-input').value);
    const presetOpt = row.querySelector('.preset-select').selectedOptions[0];
    const scheme = presetOpt ? presetOpt.dataset.scheme : 'regular';
    const presetRate = presetOpt ? num(presetOpt.dataset.rate) : 0;

    const sState = supplierStateCode();
    const pState = posSelect.value;
    const interState = sState && pState ? sState !== pState : false;

    const taxableValue = qty * rate;
    let cgst = 0, sgst = 0, igst = 0;
    if (scheme === 'regular' && presetRate > 0) {
      if (interState) igst = (taxableValue * presetRate) / 100;
      else { cgst = (taxableValue * presetRate) / 2 / 100; sgst = cgst; }
    }
    const total = taxableValue + cgst + sgst + igst;

    row.querySelector('.taxable-out').textContent = fmt(taxableValue);
    row.querySelector('.cgst-out').textContent = fmt(cgst);
    row.querySelector('.sgst-out').textContent = fmt(sgst);
    row.querySelector('.igst-out').textContent = fmt(igst);
    row.querySelector('.total-out').textContent = fmt(total);

    recalcAll();
  }

  function recalcAll() {
    let t = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    body.querySelectorAll('.line-row').forEach(row => {
      t.taxableValue += num(row.querySelector('.taxable-out').textContent);
      t.cgst += num(row.querySelector('.cgst-out').textContent);
      t.sgst += num(row.querySelector('.sgst-out').textContent);
      t.igst += num(row.querySelector('.igst-out').textContent);
      t.total += num(row.querySelector('.total-out').textContent);
    });
    document.getElementById('totTaxable').textContent = fmt(t.taxableValue);
    document.getElementById('totCgst').textContent = fmt(t.cgst);
    document.getElementById('totSgst').textContent = fmt(t.sgst);
    document.getElementById('totIgst').textContent = fmt(t.igst);
    document.getElementById('totTotal').textContent = fmt(t.total);
  }

  function readPrefill() {
    const el = document.getElementById('prefillData');
    const b64 = el && el.dataset.prefillB64;
    if (!b64) return null;
    try { return JSON.parse(atob(b64)); } catch (e) { return null; }
  }

  addLineBtn.addEventListener('click', () => addLine());
  gstinSelect.addEventListener('change', updateSupplyType);
  posSelect.addEventListener('change', updateSupplyType);
  partySelect.addEventListener('change', () => {
    const opt = partySelect.options[partySelect.selectedIndex];
    if (opt) posSelect.value = opt.dataset.state;
    updateSupplyType();
  });

  fetch('/api/context').then(r => r.json()).then(data => {
    ctx = data;
    populatePartySelect();

    const prefill = readPrefill();
    if (prefill) {
      if (prefill.gstinId != null) gstinSelect.value = prefill.gstinId;
      if (prefill.type) docTypeSelect.value = prefill.type;
      if (prefill.partyId != null) partySelect.value = prefill.partyId;
      if (prefill.placeOfSupplyStateCode) posSelect.value = prefill.placeOfSupplyStateCode;
      updateSupplyType();
      (prefill.lineItems || []).forEach(li => addLine(li));
    } else {
      updateSupplyType();
      addLine();
    }
  });
})();
