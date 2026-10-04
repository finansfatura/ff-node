// Builders for the two-layer issue payload, with the exact field casing the API
// expects.
//
// Gotcha the API imposes: the outer layer is snake_case (`document_type`,
// `canonical`) but everything inside `canonical` is PascalCase (`Recipient`,
// `Lines`, `Totals`, `VKNorTCKN` …). A snake_case key inside `canonical` is
// silently ignored. These builders encode that so callers never get it wrong.
//
// The one exception is the `*_info` blocks (`return_info` and the
// document-type extras): those DO carry a json tag on the server, so there the
// snake_case key is the correct one and PascalCase is the one that gets dropped.
//
// Totals are computed from the lines with exact decimal (BigInt) arithmetic to
// avoid float kuruş drift; `LineTotal` is the KDV-excl net used verbatim by the
// server.

// --- exact decimal helpers (money must not drift; JS has no Decimal) --------

// ponytail: plain decimal notation only; a value that stringifies to
// scientific notation (1e-7) throws — pass it as a string if you ever need that.
function toScaled(x) {
  const s = (typeof x === "string" ? x.trim() : String(x));
  if (/[eE]/.test(s)) throw new Error(`pass very large/small numbers as strings, got: ${s}`);
  const neg = s.startsWith("-");
  const body = neg || s.startsWith("+") ? s.slice(1) : s;
  const [int, frac = ""] = body.split(".");
  const digits = BigInt((int || "0") + frac) * (neg ? -1n : 1n);
  return { digits, scale: frac.length };
}

// Round a scaled integer down to 2 decimals, banker's rounding (round-half-even,
// matching Python's Decimal default).
function roundTo2(digits, scale) {
  if (scale <= 2) return digits * 10n ** BigInt(2 - scale);
  const div = 10n ** BigInt(scale - 2);
  const neg = digits < 0n;
  let a = neg ? -digits : digits;
  let q = a / div;
  const r = a % div;
  const half = div / 2n; // div is a power of 10 ≥ 100 → exact half
  if (r > half || (r === half && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

// Multiply two decimal-ish inputs, return the product as integer cents (scale 2).
function mulCents(a, b) {
  const x = toScaled(a);
  const y = toScaled(b);
  return roundTo2(x.digits * y.digits, x.scale + y.scale);
}

const centsToNum = (c) => Number(c) / 100;

function party(p) {
  return {
    VKNorTCKN: p.vkn_tckn,
    Title: p.title || "",
    Address: p.address || "",
    TaxOffice: p.tax_office || "",
    Email: p.email || "",
    Phone: p.phone || "",
  };
}

function linesAndTotals(lines, exemptionCode = "", exemptionReason = "") {
  const code = String(exemptionCode).trim();
  const reason = String(exemptionReason).trim();
  const canon = [];
  let subtotal = 0n; // cents
  let vatTotal = 0n; // cents
  for (const l of lines) {
    const lineNet = mulCents(l.qty, l.unit_price); // cents, scale 2
    // net (cents) * rate → cents; net is scale-2, so mulCents keeps it exact
    const vat = roundTo2(lineNet * toScaled(l.vat_rate).digits, 2 + toScaled(l.vat_rate).scale);
    subtotal += lineNet;
    vatTotal += vat;
    const line = {
      Title: l.title,
      ProductCode: l.product_code || "",
      Quantity: Number(l.qty),
      UnitPrice: Number(l.unit_price),
      UnitCode: l.unit_code || "C62",
      VatRate: Number(l.vat_rate), // 0.20 == %20
      LineTotal: centsToNum(lineNet),
    };
    // TEVKİFAT — satır bazında, kod yeterli. ORAN GÖNDERİLMEZ: her GİB kodunun
    // yasal oranı sabittir ve sunucu oranı koddan türetir (612 temizlik 2023'te
    // 7/10 → 9/10). Oranı istemciden almak eski entegrasyonların yanlış beyanı
    // demekti.
    if (l.withholding_code) {
      line.WithholdingCode = String(l.withholding_code).trim();
      if (l.withholding_name) line.WithholdingName = String(l.withholding_name);
    }
    // ÖZEL MATRAH — KDV'nin hesaplanacağı taban satırın net tutarından FARKLIYSA.
    // İstisnayla karıştırma: orada KDV yoktur, burada vardır.
    if (l.tax_base_amount) {
      line.TaxBaseAmount = Number(l.tax_base_amount);
      line.TaxBaseCode = String(l.tax_base_code ?? "").trim();
      line.TaxBaseReason = String(l.tax_base_reason ?? "").trim();
    }
    // VAT EXEMPTION — zero-VAT lines only, exactly as the server does it:
    // attaching it to a VAT-bearing line would make the exemption look like it
    // covers that line too.
    if (Number(l.vat_rate) === 0) {
      if (!code || !reason) {
        throw new Error(
          "a line with vat_rate 0 needs opts.exemptionCode and opts.exemptionReason — " +
            "GİB rejects a zero-VAT line without an exemption reason",
        );
      }
      line.TaxExemptionReasonCode = code;
      line.TaxExemptionReason = reason;
    }
    canon.push(line);
  }
  const totals = {
    SubtotalExclVAT: centsToNum(subtotal),
    VatTotal: centsToNum(vatTotal),
    DiscountTotal: 0,
    GrandTotal: centsToNum(subtotal + vatTotal),
  };
  return { canon, totals };
}

/** IADE, TEVKIFATIADE and YTBIADE all need the original-invoice reference. */
function isReturnType(code) {
  return ["IADE", "TEVKIFATIADE", "YTBIADE"].includes(String(code).trim().toUpperCase());
}

/**
 * The refunded invoice's number + issue date. The date goes out as RFC 3339
 * because the server parses it into a Go `time.Time`; a bare "2026-09-27"
 * fails to unmarshal and surfaces as a meaningless 400.
 */
function originalRef(ref) {
  const number = String(ref?.number ?? "").trim();
  const date = String(ref?.issue_date ?? "").trim();
  if (!number || !date) {
    throw new Error(
      'a refund needs opts.returnInfo = { number, issue_date: "YYYY-MM-DD" } — ' +
        "GİB rejects a refund without the original invoice reference",
    );
  }
  return {
    Number: number,
    IssueDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date,
  };
}

/**
 * Validate the e-Fatura scenario. Empty is fine — the server defaults to
 * TICARIFATURA. Anything else is rejected here rather than silently
 * overwritten server-side.
 */
function normalizeScenario(documentType, scenario) {
  const s = String(scenario || "").trim().toUpperCase();
  if (!s) return "";
  if (String(documentType).toUpperCase() !== "EFATURA") {
    throw new Error(
      `opts.scenario only applies to EFATURA; ${documentType} has a fixed scenario`,
    );
  }
  if (s !== "TEMELFATURA" && s !== "TICARIFATURA") {
    throw new Error(`opts.scenario must be TEMELFATURA or TICARIFATURA, got: ${s}`);
  }
  return s;
}

/**
 * Generic builder. `recipient`/`issuer` are objects with `vkn_tckn` + optional
 * `title`/`address`/`tax_office`/`email`/`phone`. `lines` are objects with
 * `title`/`qty`/`unit_price`/`vat_rate` (+ optional `product_code`/`unit_code`).
 *
 * `transactionHeaderId` is REQUIRED — the `transaction_id` returned by
 * `createOrder()`. Every document hangs off a sale: that is what feeds the
 * turnover report, the current account and stock. The server rejects a sale-less
 * document for API clients too; this throws before the request so you don't burn
 * a round trip.
 *
 * The one exception is a refund (`invoiceTypeCode: "IADE"`): attaching it to the
 * sale would count that sale twice, so it is issued unattached.
 *
 * Leave `recipientAlias` empty unless you know the mailbox handle: the server
 * looks the VKN up at GİB and upgrades `EARSIV` to `EFATURA` (with the right
 * alias) when the recipient turns out to be registered.
 *
 * Do NOT pass `issuer` in production — the server fills seller identity from the
 * company profile. It exists only for testing before the profile VKN is set.
 *
 * A refund (`invoiceTypeCode`: `IADE`/`TEVKIFATIADE`/`YTBIADE`) needs the
 * ORIGINAL invoice it refunds: pass `returnInfo` as
 * `{ number: "FF32026000000123", issue_date: "2026-09-27" }`. GİB rejects a
 * refund without that reference, so this is required, not optional.
 *
 * `currency` + `exchangeRate` only matter on a refund: on a sale the server
 * takes both from the sale itself. A refund repeats the rate the original sale
 * carried — it does not set a new one.
 *
 * `scenario` picks the e-Fatura scenario and only applies to `EFATURA`:
 * `TEMELFATURA` (the recipient cannot answer; the document is final) or
 * `TICARIFATURA` (the recipient may send KABUL/RED within 8 days, the default).
 * The difference is legal, not cosmetic. e-Arşiv has no choice.
 *
 * A line with `vat_rate` 0 needs a VAT-exemption reason — GİB rejects a zero-VAT
 * line without one — so pass `exemptionCode` + `exemptionReason`. The code is
 * document-level and lands only on the zero-VAT lines.
 */
export function buildPayload(
  documentType,
  recipient,
  lines,
  {
    transactionHeaderId,
    issuer,
    recipientAlias = "",
    invoiceTypeCode = "SATIS",
    note,
    exemptionCode,
    exemptionReason,
    scenario,
    returnInfo,
    currency,
    exchangeRate,
    exchangeRateDate,
  } = {},
) {
  // Muafiyet ÜÇ iade tipini de kapsar (bkz. isReturnType): TEVKIFATIADE ve
  // YTBIADE de iadedir ve satışa bağlanırsa aynı satış iki kez sayılır.
  if (!transactionHeaderId && !isReturnType(invoiceTypeCode)) {
    throw new Error(
      "transactionHeaderId is required — create the sale first with createOrder() and pass its transaction_id",
    );
  }
  const { canon, totals } = linesAndTotals(lines, exemptionCode, exemptionReason);
  const scen = normalizeScenario(documentType, scenario);
  const cur = String(currency || "TRY").trim().toUpperCase() || "TRY";
  const canonical = {
    DocumentType: documentType,
    InvoiceTypeCode: invoiceTypeCode,
    Currency: cur,
    RecipientAlias: recipientAlias || "",
    Recipient: party(recipient),
    Lines: canon,
    Totals: totals,
  };
  if (scen) canonical.Scenario = scen;
  if (cur !== "TRY") {
    const rate = Number(exchangeRate || 0);
    if (!(rate > 0)) {
      throw new Error(
        "opts.exchangeRate is required when currency is not TRY — " +
          "a foreign-currency document cannot be issued without the TL rate",
      );
    }
    canonical.ExchangeRate = rate;
    if (exchangeRateDate) canonical.ExchangeRateDate = String(exchangeRateDate);
  }
  // İADE ATFI — anahtar snake_case: canonical'ın geri kalanı PascalCase bağlanır
  // (alanların json tag'i yok) ama *_info blokları TAG'LIDIR. "ReturnInfo"
  // sessizce düşer ve belge atıfsız iade olarak reddedilir.
  if (isReturnType(invoiceTypeCode)) {
    canonical.return_info = { Originals: [originalRef(returnInfo)] };
  } else if (returnInfo != null) {
    throw new Error(
      "opts.returnInfo only applies to a refund — set invoiceTypeCode to IADE",
    );
  }
  if (issuer != null) canonical.Issuer = party(issuer);
  if (note) canonical.Note = note;
  const payload = { document_type: documentType, canonical };
  if (transactionHeaderId) payload.transaction_header_id = transactionHeaderId;
  return payload;
}

/**
 * e-Arşiv (final consumer / non-registered recipient — TCKN is fine).
 *
 * The safe default for e-commerce: if the buyer turns out to be a registered
 * e-Fatura taxpayer, the server upgrades the document for you.
 */
export function buildEarsivPayload(recipient, lines, opts = {}) {
  return buildPayload("EARSIV", recipient, lines, opts);
}

/**
 * e-Fatura (GİB-registered recipient). `recipientAlias` is optional — the server
 * resolves the mailbox handle from the VKN when you leave it empty.
 */
export function buildEfaturaPayload(recipient, lines, recipientAlias = "", opts = {}) {
  return buildPayload("EFATURA", recipient, lines, { ...opts, recipientAlias });
}
