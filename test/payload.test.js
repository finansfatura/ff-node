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
    // %0 KDV olduğu için istisna sebebi de şart (bkz. istisna testi)
    { transactionHeaderId: "t-1", exemptionCode: "301", exemptionReason: "11/1-a Mal ihracatı" },
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
  // iade ASIL FATURA ATFI ister — GİB atıfsız iadeyi reddediyor
  const iade = buildEarsivPayload({ vkn_tckn: "1" }, lines, {
    invoiceTypeCode: "IADE",
    returnInfo: { number: "FF32026000000123", issue_date: "2026-09-27" },
  });
  assert.ok(!("transaction_header_id" in iade));
  assert.equal(iade.canonical.InvoiceTypeCode, "IADE");
});

// İstisna BELGE DÜZEYİNDE verilir, yalnız %0 satırlara iner. KDV'li satıra
// iliştirilse istisna beyanı o satırı da kapsamış görünürdü.
test("KDV istisnası yalnız %0 satırlara iner", () => {
  const p = buildEarsivPayload(
    { vkn_tckn: "1" },
    [
      { title: "İstisnalı", qty: 1, unit_price: 100.0, vat_rate: 0 },
      { title: "KDV'li", qty: 1, unit_price: 100.0, vat_rate: 0.2 },
    ],
    { transactionHeaderId: "t-1", exemptionCode: "301", exemptionReason: "11/1-a Mal ihracatı" },
  );
  assert.equal(p.canonical.Lines[0].TaxExemptionReasonCode, "301");
  assert.equal(p.canonical.Lines[0].TaxExemptionReason, "11/1-a Mal ihracatı");
  assert.equal(p.canonical.Lines[1].TaxExemptionReasonCode, undefined);
});

// Sunucu zaten ERROR_INVOICE_ZERO_VAT_NEEDS_EXEMPTION döner; burada hata
// alanın adıyla, istek gitmeden gelir.
test("%0 KDV istisna sebebi olmadan reddedilir", () => {
  const zero = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0 }];
  assert.throws(
    () => buildEarsivPayload({ vkn_tckn: "1" }, zero, { transactionHeaderId: "t-1" }),
    /exemptionCode/,
  );
  // kod var metin yok → GİB cbc:TaxExemptionReason'ı boş kabul etmiyor
  assert.throws(
    () =>
      buildEarsivPayload({ vkn_tckn: "1" }, zero, {
        transactionHeaderId: "t-1",
        exemptionCode: "301",
      }),
    /exemptionReason/,
  );
});

// TEMEL ile TİCARİ farkı hukuki: TEMEL'de alıcı yanıt veremez, belge kesindir.
test("senaryo yalnız EFATURA'da, büyük harfe çevrilir", () => {
  const line = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  const p = buildEfaturaPayload({ vkn_tckn: "1234567801" }, line, "", {
    transactionHeaderId: "t-1",
    scenario: "temelfatura",
  });
  assert.equal(p.canonical.Scenario, "TEMELFATURA");

  // verilmezse hiç gönderilmez — sunucu TICARIFATURA'ya normalleştirir
  const def = buildEfaturaPayload({ vkn_tckn: "1234567801" }, line, "", {
    transactionHeaderId: "t-1",
  });
  assert.equal(def.canonical.Scenario, undefined);

  // e-Arşiv'de seçim yok; sunucuda sessizce ezilmek yerine burada patlar
  assert.throws(
    () => buildEarsivPayload({ vkn_tckn: "1" }, line, {
      transactionHeaderId: "t-1",
      scenario: "TEMELFATURA",
    }),
    /EFATURA/,
  );
  assert.throws(
    () => buildEfaturaPayload({ vkn_tckn: "1234567801" }, line, "", {
      transactionHeaderId: "t-1",
      scenario: "IHRACAT",
    }),
    /TEMELFATURA/,
  );
});

// Atıf anahtarı snake_case (`return_info`) olmalı: o alan sunucuda TAG'LI,
// PascalCase yazım sessizce düşüyor ve belge atıfsız iade olarak çıkıyor.
test("iade atfı snake_case anahtarla ve RFC 3339 tarihle gider", () => {
  const line = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  const p = buildEarsivPayload({ vkn_tckn: "1" }, line, {
    invoiceTypeCode: "IADE",
    returnInfo: { number: "FF32026000000123", issue_date: "2026-09-27" },
  });
  assert.equal(p.canonical.ReturnInfo, undefined);
  const ref = p.canonical.return_info.Originals[0];
  assert.equal(ref.Number, "FF32026000000123");
  assert.equal(ref.IssueDate, "2026-09-27T00:00:00Z");
});

test("atıfsız iade reddedilir", () => {
  const line = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  for (const invoiceTypeCode of ["IADE", "TEVKIFATIADE", "YTBIADE"]) {
    assert.throws(
      () => buildEarsivPayload({ vkn_tckn: "1" }, line, { invoiceTypeCode }),
      /returnInfo/,
    );
  }
  // satış belgesine atıf iliştirilmez
  assert.throws(
    () =>
      buildEarsivPayload({ vkn_tckn: "1" }, line, {
        transactionHeaderId: "t-1",
        returnInfo: { number: "X", issue_date: "2026-09-27" },
      }),
    /refund/,
  );
});

// Para birimi/kur yalnız iadede anlamlı: satışta sunucu ikisini de satıştan alır.
test("dövizli belge kur ister", () => {
  const line = [{ title: "A", qty: 1, unit_price: 100.0, vat_rate: 0.2 }];
  const ref = { number: "FF32026000000123", issue_date: "2026-09-27" };
  const usd = buildEarsivPayload({ vkn_tckn: "1" }, line, {
    invoiceTypeCode: "IADE",
    returnInfo: ref,
    currency: "usd",
    exchangeRate: 41.37,
    exchangeRateDate: "2026-09-27",
  });
  assert.equal(usd.canonical.Currency, "USD");
  assert.equal(usd.canonical.ExchangeRate, 41.37);
  assert.equal(usd.canonical.ExchangeRateDate, "2026-09-27");

  // TRY belgede kur alanı hiç gönderilmez
  const tryDoc = buildEarsivPayload({ vkn_tckn: "1" }, line, { transactionHeaderId: "t-1" });
  assert.equal(tryDoc.canonical.ExchangeRate, undefined);

  assert.throws(
    () =>
      buildEarsivPayload({ vkn_tckn: "1" }, line, {
        invoiceTypeCode: "IADE",
        returnInfo: ref,
        currency: "USD",
      }),
    /exchangeRate/,
  );
});

// ORAN GÖNDERİLMEZ: her GİB kodunun yasal oranı sabit, sunucu koddan türetiyor.
test("tevkifat ve özel matrah satır bazında, oransız gider", () => {
  const p = buildEarsivPayload(
    { vkn_tckn: "1" },
    [
      {
        title: "Temizlik hizmeti", qty: 1, unit_price: 1000.0, vat_rate: 0.2,
        withholding_code: " 612 ", withholding_name: "Temizlik hizmeti",
      },
      {
        title: "İkinci el araç", qty: 1, unit_price: 550000.0, vat_rate: 0.2,
        tax_base_amount: 50000.0, tax_base_code: "812",
        tax_base_reason: "İkinci el araç kâr marjı",
      },
    ],
    { transactionHeaderId: "t-1" },
  );
  const [wl, tb] = p.canonical.Lines;
  assert.equal(wl.WithholdingCode, "612");
  assert.equal(wl.WithholdingPercent, undefined, "oran gönderilmemeli");
  assert.equal(tb.TaxBaseAmount, 50000.0);
  assert.equal(tb.TaxBaseCode, "812");
  assert.equal(wl.TaxBaseAmount, undefined);
  assert.equal(tb.WithholdingCode, undefined);
});
