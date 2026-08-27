import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEarsivPayload, buildEfaturaPayload } from "../src/payload.js";

test("earsiv casing and totals", () => {
  const p = buildEarsivPayload(
    { vkn_tckn: "11111111111", title: "Ahmet" },
    [
      { title: "A", qty: 2, unit_price: 100.0, vat_rate: 0.2 },
      { title: "B", qty: 1, unit_price: 50.0, vat_rate: 0.2 },
    ],
    { transactionHeaderId: "t-1" },
  );
  assert.equal(p.document_type, "EARSIV");
  const c = p.canonical;
  assert.equal(c.DocumentType, "EARSIV");
  assert.equal(c.Recipient.VKNorTCKN, "11111111111");
  // 2*100 + 1*50 = 250 net, 20% KDV = 50, grand 300
  assert.equal(c.Totals.SubtotalExclVAT, 250.0);
  assert.equal(c.Totals.VatTotal, 50.0);
  assert.equal(c.Totals.GrandTotal, 300.0);
  assert.equal(c.Lines[0].LineTotal, 200.0);
  assert.ok(!("Issuer" in c)); // must not be present unless injected
});

test("issuer injection and efatura alias", () => {
  const p = buildEfaturaPayload(
    { vkn_tckn: "1234567801", title: "Kurum" },
    [{ title: "X", qty: 1, unit_price: 10.0, vat_rate: 0.2 }],
    "urn:mail:defaultpk@example.com",
    { issuer: { vkn_tckn: "1234567801", title: "Satici" }, transactionHeaderId: "t-1" },
  );
  const c = p.canonical;
  assert.equal(c.DocumentType, "EFATURA");
  assert.equal(c.RecipientAlias, "urn:mail:defaultpk@example.com");
  assert.equal(c.Issuer.VKNorTCKN, "1234567801");
});

test("no float drift — banker's rounding on kuruş", () => {
  // 3 * 33.33 = 99.99 exactly; 49.995 rounds half-even to 50.00
  const p = buildEarsivPayload(
    { vkn_tckn: "1" },
    [
      { title: "A", qty: 3, unit_price: "33.33", vat_rate: 0 },
      { title: "B", qty: "1.5", unit_price: "33.33", vat_rate: 0 }, // 49.995 -> 50.00
    ],
    { transactionHeaderId: "t-1" },
  );
  assert.equal(p.canonical.Lines[0].LineTotal, 99.99);
  assert.equal(p.canonical.Lines[1].LineTotal, 50.0);
  assert.equal(p.canonical.Totals.SubtotalExclVAT, 149.99);
});

test("transaction_header_id is attached and the alias defaults to empty", () => {
  const lines = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  const p = buildEarsivPayload({ vkn_tckn: "11111111111" }, lines, {
    transactionHeaderId: "9f1c2d3e-4a5b",
  });
  assert.equal(p.transaction_header_id, "9f1c2d3e-4a5b");
  // empty alias is sent explicitly — that's what makes the server resolve it
  assert.equal(p.canonical.RecipientAlias, "");
});

test("the sale is mandatory — except for refunds", () => {
  const lines = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  // every document hangs off a sale — no sale id, no payload
  assert.throws(() => buildEarsivPayload({ vkn_tckn: "1" }, lines), /transactionHeaderId is required/);
  // …except a refund: attaching it would count the sale twice
  const iade = buildEarsivPayload({ vkn_tckn: "1" }, lines, { invoiceTypeCode: "IADE" });
  assert.ok(!("transaction_header_id" in iade));
  assert.equal(iade.canonical.InvoiceTypeCode, "IADE");
});
