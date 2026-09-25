const crypto = require('crypto');
const QRCode = require('qrcode');

// Builds a simplified GST INV-01-style payload. Not a full schema implementation —
// enough structure to demonstrate the shape and to drive the mock IRP response.
function buildInvJson({ invoice, gstin, supplier, party }) {
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: invoice.interState ? 'B2B' : 'B2B', RegRev: invoice.reverseCharge ? 'Y' : 'N' },
    DocDtls: { Typ: invoice.type === 'credit_note' ? 'CRN' : invoice.type === 'debit_note' ? 'DBN' : 'INV', No: invoice.invoiceNo, Dt: invoice.date },
    SellerDtls: { Gstin: gstin.gstin, LglNm: supplier.legalName, Addr1: supplier.address || '', Stcd: gstin.stateCode },
    BuyerDtls: { Gstin: party.gstin || 'URP', LglNm: party.name, Addr1: party.address || '', Stcd: party.stateCode, Pos: invoice.placeOfSupplyStateCode },
    ItemList: invoice.lineItems.map((li, i) => ({
      SlNo: String(i + 1),
      PrdDesc: li.description,
      HsnCd: li.hsnSac,
      Qty: li.qty,
      Unit: li.unit,
      UnitPrice: li.rate,
      TotAmt: li.taxableValue,
      AssAmt: li.taxableValue,
      CgstRt: li.cgstRate || 0,
      CgstAmt: li.cgst,
      SgstRt: li.sgstRate || 0,
      SgstAmt: li.sgst,
      IgstRt: li.igstRate || 0,
      IgstAmt: li.igst,
      TotItemVal: li.total
    })),
    ValDtls: {
      AssVal: invoice.totals.taxableValue,
      CgstVal: invoice.totals.cgst,
      SgstVal: invoice.totals.sgst,
      IgstVal: invoice.totals.igst,
      TotInvVal: invoice.totals.total
    }
  };
}

async function generateMockIRN({ invoice, gstin, supplier, party }) {
  const invJson = buildInvJson({ invoice, gstin, supplier, party });
  const seed = JSON.stringify(invJson) + '|' + Date.now() + '|' + Math.random();
  const irn = crypto.createHash('sha256').update(seed).digest('hex');
  const ackNo = String(Math.floor(100000000000000 + Math.random() * 900000000000000));
  const ackDate = new Date().toISOString();

  // Simplified signed-QR payload (real IRP returns a base64 digitally-signed JWS; this is a mock)
  const qrPayload = JSON.stringify({
    SellerGstin: gstin.gstin,
    BuyerGstin: party.gstin || 'URP',
    DocNo: invoice.invoiceNo,
    DocTyp: invJson.DocDtls.Typ,
    DocDt: invoice.date,
    TotInvVal: invoice.totals.total,
    Irn: irn,
    IrnDt: ackDate,
    mock: true
  });

  const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 1, width: 200 });

  return {
    irn,
    ackNo,
    ackDate,
    invJson,
    qrPayload,
    qrDataUrl,
    status: 'generated',
    cancelled: false,
    cancelledAt: null
  };
}

module.exports = { generateMockIRN, buildInvJson };
