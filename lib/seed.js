require('./ensureEnv').ensureEnv();

const { load, save, nextId } = require('./store');
const { hashPassword } = require('./auth');
const { calcLine, sumTotals, isInterState } = require('./gst');
const fieldCrypto = require('./crypto');

if (!process.env.ENCRYPTION_KEY) {
  console.error('FATAL: ENCRYPTION_KEY is not set and no .env was generated (this happens in production mode -- see .env.example). Set it and re-run.');
  process.exit(1);
}

function run() {
  const db = load();

  if (db.companies.length) {
    console.log('Database already has data. Refusing to reseed. Delete data/db.json to start fresh.');
    return;
  }

  // --- Company & GSTINs -------------------------------------------------
  const companyId = nextId(db, 'companies');
  db.companies.push({
    id: companyId,
    legalName: 'Aravind Textiles Private Limited',
    tradeName: 'Aravind Textiles',
    pan: fieldCrypto.encrypt('AAACA1234A'),
    address: '12 Anna Salai, Chennai',
    bankDetails: fieldCrypto.encrypt('HDFC Bank, A/C 5020xxxxx1234, IFSC HDFC0000123'),
    logo: '',
    priorFyAato: 0 // editable later from the dashboard, used for AATO/e-invoicing threshold demo
  });

  const gstinTN = nextId(db, 'gstins');
  db.gstins.push({ id: gstinTN, companyId, gstin: '33AAACA1234A1ZR', stateCode: '33', scheme: 'regular', invoiceSeries: { 'INV': 0, 'CN': 0, 'DN': 0 } });

  const gstinKA = nextId(db, 'gstins');
  db.gstins.push({ id: gstinKA, companyId, gstin: '29AAACA1234A1ZG', stateCode: '29', scheme: 'regular', invoiceSeries: { 'INV': 0, 'CN': 0, 'DN': 0 } });

  // --- GST rate presets ---------------------------------------------------
  const presetDefs = [
    { label: 'Regular 5%', scheme: 'regular', rate: 5 },
    { label: 'Regular 12%', scheme: 'regular', rate: 12 },
    { label: 'Regular 18%', scheme: 'regular', rate: 18 },
    { label: 'Regular 28%', scheme: 'regular', rate: 28 },
    { label: 'Composition 1%', scheme: 'composition', rate: 1 },
    { label: 'Composition 5%', scheme: 'composition', rate: 5 },
    { label: 'Composition 6%', scheme: 'composition', rate: 6 },
    { label: 'Exempt / Nil-rated', scheme: 'exempt', rate: 0 }
  ];
  const presets = {};
  for (const p of presetDefs) {
    const id = nextId(db, 'gstPresets');
    const rec = { id, ...p };
    rec.companyId = companyId;
    db.gstPresets.push(rec);
    presets[p.label] = rec;
  }

  // --- Parties (customers & vendors) --------------------------------------
  const custChennai = nextId(db, 'parties');
  db.parties.push({ id: custChennai, companyId, type: 'customer', active: true, name: 'Meenakshi Garments', gstin: '33BBPCM5678K1ZO', address: 'T Nagar, Chennai', stateCode: '33', isRegistered: true });

  const custBengaluru = nextId(db, 'parties');
  db.parties.push({ id: custBengaluru, companyId, type: 'customer', active: true, name: 'Namma Fashion Retail LLP', gstin: '29AAFFN2345L1ZZ', address: 'Jayanagar, Bengaluru', stateCode: '29', isRegistered: true });

  const custMumbai = nextId(db, 'parties');
  db.parties.push({ id: custMumbai, companyId, type: 'customer', active: true, name: 'Konkan Apparel Co.', gstin: '27AAGCK7890M1ZP', address: 'Andheri, Mumbai', stateCode: '27', isRegistered: true });

  const custUnregistered = nextId(db, 'parties');
  db.parties.push({ id: custUnregistered, companyId, type: 'customer', active: true, name: 'Walk-in Customer', gstin: '', address: 'Chennai', stateCode: '33', isRegistered: false });

  const vendorYarn = nextId(db, 'parties');
  db.parties.push({ id: vendorYarn, companyId, type: 'vendor', active: true, name: 'Coimbatore Yarn Suppliers', gstin: '33AACFC4567N1Z8', address: 'Coimbatore', stateCode: '33', isRegistered: true });

  const vendorDye = nextId(db, 'parties');
  db.parties.push({ id: vendorDye, companyId, type: 'vendor', active: true, name: 'Tirupur Dyeing Works', gstin: '33AADFT8901P1ZS', address: 'Tirupur', stateCode: '33', isRegistered: true });

  // --- Products/services ----------------------------------------------
  const p1 = nextId(db, 'products');
  db.products.push({ id: p1, companyId, active: true, description: "Men's Cotton Shirt", hsnSac: '6205', unit: 'PCS', rate: 450, defaultPresetLabel: 'Regular 5%' });

  const p2 = nextId(db, 'products');
  db.products.push({ id: p2, companyId, active: true, description: "Women's Cotton Kurti", hsnSac: '6204', unit: 'PCS', rate: 650, defaultPresetLabel: 'Regular 12%' });

  const p3 = nextId(db, 'products');
  db.products.push({ id: p3, companyId, active: true, description: 'Synthetic Blended Fabric (per meter)', hsnSac: '5407', unit: 'MTR', rate: 180, defaultPresetLabel: 'Regular 18%' });

  const p4 = nextId(db, 'products');
  db.products.push({ id: p4, companyId, active: true, description: 'Garment Stitching & Job Work Services', hsnSac: '998821', unit: 'SVC', rate: 5000, defaultPresetLabel: 'Regular 18%' });

  const p5 = nextId(db, 'products');
  db.products.push({ id: p5, companyId, active: true, description: 'Raw Cotton (Kappas)', hsnSac: '5201', unit: 'KG', rate: 60, defaultPresetLabel: 'Exempt / Nil-rated' });

  // --- Demo invoices -------------------------------------------------
  const today = new Date();
  const period = ymPeriod(today);

  function makeInvoice({ gstinId, series, party, items, type = 'tax_invoice', reverseCharge = false }) {
    const gstin = db.gstins.find(g => g.id === gstinId);
    gstin.invoiceSeries[series] = (gstin.invoiceSeries[series] || 0) + 1;
    const invoiceNo = `${series}-${String(gstin.invoiceSeries[series]).padStart(4, '0')}`;
    const placeOfSupplyStateCode = party.stateCode;
    const interState = isInterState(gstin.stateCode, placeOfSupplyStateCode);

    const lineItems = items.map(it => {
      const preset = presets[it.presetLabel];
      const calc = calcLine({ qty: it.qty, rate: it.rate, preset, interState });
      return {
        description: it.description,
        hsnSac: it.hsnSac,
        unit: it.unit,
        qty: it.qty,
        rate: it.rate,
        presetId: preset.id,
        presetLabel: preset.label,
        cgstRate: interState || preset.scheme !== 'regular' ? 0 : preset.rate / 2,
        sgstRate: interState || preset.scheme !== 'regular' ? 0 : preset.rate / 2,
        igstRate: !interState || preset.scheme !== 'regular' ? 0 : preset.rate,
        ...calc
      };
    });
    const totals = sumTotals(lineItems);
    const id = nextId(db, 'invoices');
    const invoice = {
      id, companyId, gstinId, invoiceNo, series, type,
      date: today.toISOString().slice(0, 10),
      period,
      partyId: party.id,
      placeOfSupplyStateCode,
      interState,
      reverseCharge,
      lineItems,
      totals,
      einvoice: null,
      status: 'finalized'
    };
    db.invoices.push(invoice);
    return invoice;
  }

  // Intra-state invoice (TN GSTIN -> TN customer): CGST+SGST
  makeInvoice({
    gstinId: gstinTN, series: 'INV', party: db.parties.find(p => p.id === custChennai),
    items: [
      { description: p1_desc(), hsnSac: '6205', unit: 'PCS', qty: 20, rate: 450, presetLabel: 'Regular 5%' },
      { description: "Women's Cotton Kurti", hsnSac: '6204', unit: 'PCS', qty: 10, rate: 650, presetLabel: 'Regular 12%' }
    ]
  });

  // Inter-state invoice (TN GSTIN -> Karnataka customer): IGST
  makeInvoice({
    gstinId: gstinTN, series: 'INV', party: db.parties.find(p => p.id === custBengaluru),
    items: [
      { description: 'Synthetic Blended Fabric (per meter)', hsnSac: '5407', unit: 'MTR', qty: 300, rate: 180, presetLabel: 'Regular 18%' }
    ]
  });

  // Inter-state invoice (TN GSTIN -> Maharashtra customer): IGST, services
  makeInvoice({
    gstinId: gstinTN, series: 'INV', party: db.parties.find(p => p.id === custMumbai),
    items: [
      { description: 'Garment Stitching & Job Work Services', hsnSac: '998821', unit: 'SVC', qty: 1, rate: 5000, presetLabel: 'Regular 18%' }
    ]
  });

  // Intra-state B2C invoice (Karnataka GSTIN -> unregistered) - Bill of Supply not needed since regular+taxable so Tax Invoice
  makeInvoice({
    gstinId: gstinKA, series: 'INV', party: db.parties.find(p => p.id === custUnregistered),
    items: [
      { description: "Men's Cotton Shirt", hsnSac: '6205', unit: 'PCS', qty: 3, rate: 450, presetLabel: 'Regular 5%' }
    ]
  });

  // Exempt supply example (Bill of Supply territory)
  makeInvoice({
    gstinId: gstinTN, series: 'INV', party: db.parties.find(p => p.id === custChennai), type: 'bill_of_supply',
    items: [
      { description: 'Raw Cotton (Kappas)', hsnSac: '5201', unit: 'KG', qty: 500, rate: 60, presetLabel: 'Exempt / Nil-rated' }
    ]
  });

  // --- Purchase register (for 2A/2B reconciliation demo) ------------------
  function makePurchase({ vendor, invoiceNo, taxableValue, rate, itcEligible = true }) {
    const id = nextId(db, 'purchaseInvoices');
    const cgst = round2((taxableValue * rate) / 2 / 100);
    const sgst = cgst;
    db.purchaseInvoices.push({
      id, companyId, vendorId: vendor.id, invoiceNo, date: today.toISOString().slice(0, 10), period,
      taxableValue, cgst, sgst, igst: 0, total: round2(taxableValue + cgst + sgst), itcEligible
    });
  }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  makePurchase({ vendor: db.parties.find(p => p.id === vendorYarn), invoiceNo: 'CYS-2201', taxableValue: 80000, rate: 5 });
  makePurchase({ vendor: db.parties.find(p => p.id === vendorDye), invoiceNo: 'TDW-0876', taxableValue: 35000, rate: 18 });

  // --- Users ---------------------------------------------------------
  const ownerId = nextId(db, 'users');
  const { salt, hash } = hashPassword('owner123');
  db.users.push({ id: ownerId, name: 'Balaji (Owner)', email: 'owner@aravindtextiles.example', salt, hash, role: 'owner', companyId, active: true });

  const acctId = nextId(db, 'users');
  const acct = hashPassword('accountant123');
  db.users.push({ id: acctId, name: 'Priya (Accountant)', email: 'accountant@aravindtextiles.example', salt: acct.salt, hash: acct.hash, role: 'accountant', companyId, active: true });

  const caId = nextId(db, 'users');
  const ca = hashPassword('ca123');
  db.users.push({ id: caId, name: 'CA Ramesh & Co.', email: 'ca@rameshandco.example', salt: ca.salt, hash: ca.hash, role: 'ca', companyId, active: true });

  const viewerId = nextId(db, 'users');
  const viewer = hashPassword('viewer123');
  db.users.push({ id: viewerId, name: 'Kavya (Viewer)', email: 'viewer@aravindtextiles.example', salt: viewer.salt, hash: viewer.hash, role: 'viewer', companyId, active: true });

  save(db);
  console.log('Seed complete.');
  console.log('Login with: owner@aravindtextiles.example / owner123  (or accountant@... / accountant123, ca@... / ca123, viewer@... / viewer123)');

  function p1_desc() { return "Men's Cotton Shirt"; }
  function ymPeriod(d) { return d.toISOString().slice(0, 7); }
}

run();
