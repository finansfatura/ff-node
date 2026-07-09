// Builders for the two-layer issue payload, with the exact field casing the API
// expects.
//
// Gotcha the API imposes: the outer layer is snake_case (`document_type`,
// `canonical`) but everything inside `canonical` is PascalCase (`Recipient`,
// `Lines`, `Totals`, `VKNorTCKN` …). A snake_case key inside `canonical` is
// silently ignored. These builders encode that so callers never get it wrong.
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

function linesAndTotals(lines) {
  const canon = [];
  let subtotal = 0n; // cents
  let vatTotal = 0n; // cents
  for (const l of lines) {
    const lineNet = mulCents(l.qty, l.unit_price); // cents, scale 2
    // net (cents) * rate → cents; net is scale-2, so mulCents keeps it exact
    const vat = roundTo2(lineNet * toScaled(l.vat_rate).digits, 2 + toScaled(l.vat_rate).scale);
    subtotal += lineNet;
    vatTotal += vat;
    canon.push({
      Title: l.title,
      ProductCode: l.product_code || "",
      Quantity: Number(l.qty),
      UnitPrice: Number(l.unit_price),
      UnitCode: l.unit_code || "C62",
      VatRate: Number(l.vat_rate), // 0.20 == %20
      LineTotal: centsToNum(lineNet),
    });
  }
  const totals = {
    SubtotalExclVAT: centsToNum(subtotal),
    VatTotal: centsToNum(vatTotal),
    DiscountTotal: 0,
    GrandTotal: centsToNum(subtotal + vatTotal),
  };
  return { canon, totals };
}

/**
 * Generic builder. `recipient`/`issuer` are objects with `vkn_tckn` + optional
 * `title`/`address`/`tax_office`/`email`/`phone`. `lines` are objects with
 * `title`/`qty`/`unit_price`/`vat_rate` (+ optional `product_code`/`unit_code`).
 *
 * Do NOT pass `issuer` in production — the server fills seller identity from the
 * company profile. It exists only for testing before the profile VKN is set.
 */
export function buildPayload(
  documentType,
  recipient,
  lines,
  { issuer, recipientAlias, invoiceTypeCode = "SATIS", note } = {},
) {
  const { canon, totals } = linesAndTotals(lines);
  const canonical = {
    DocumentType: documentType,
    InvoiceTypeCode: invoiceTypeCode,
    Currency: "TRY",
    Recipient: party(recipient),
    Lines: canon,
    Totals: totals,
  };
  if (issuer != null) canonical.Issuer = party(issuer);
  if (recipientAlias) canonical.RecipientAlias = recipientAlias;
  if (note) canonical.Note = note;
  return { document_type: documentType, canonical };
}

/** e-Arşiv (final consumer / non-registered recipient — TCKN is fine). */
export function buildEarsivPayload(recipient, lines, opts = {}) {
  return buildPayload("EARSIV", recipient, lines, opts);
}

/**
 * e-Fatura (GİB-registered recipient). `recipientAlias` is required — the mailbox
 * handle GİB routes by (resolve it via a recipient lookup first).
 */
export function buildEfaturaPayload(recipient, lines, recipientAlias, opts = {}) {
  return buildPayload("EFATURA", recipient, lines, { ...opts, recipientAlias });
}
