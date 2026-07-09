# finansfatura

Node client for the [Finansfatura](https://finansfatura.com) e-invoice API
(e-Fatura / e-Arşiv). Issue, list, download and cancel invoices with an API key —
no WooCommerce required, this is the general external REST API.

Zero dependencies (native `fetch`, Node 18+). Ships with TypeScript types.

## Install

```bash
npm install finansfatura
```

## Quickstart

```js
import { FinansfaturaClient, buildEarsivPayload } from "finansfatura";

const ff = new FinansfaturaClient({ apiKey: process.env.FINANSFATURA_API_KEY }); // ff_live_...

const payload = buildEarsivPayload(
  { vkn_tckn: "11111111111", title: "Ahmet Yılmaz", email: "ahmet@example.com" },
  [{ title: "Kablosuz Kulaklık", product_code: "SKU-1042", qty: 1, unit_price: 100.0, vat_rate: 0.20 }],
);

const result = await ff.issueInvoice(payload, "order-1042");
console.log(result.invoice_id, result.status); // -> ... QUEUED
```

`buildEarsivPayload` computes totals from the lines (exact decimal, no float
kuruş drift) and applies the API's exact field casing for you: the outer layer is
snake_case (`document_type`, `canonical`) but everything inside `canonical` is
PascalCase (`Recipient`, `Lines`, `Totals`, `VKNorTCKN`). A snake_case key inside
`canonical` is silently ignored by the server, so let the builder handle it.

For exact money you may pass `qty` / `unit_price` / `vat_rate` as strings
(`"33.33"`) — numbers work too, the builder rounds half-even to the kuruş.

## Idempotency

The second argument to `issueInvoice` is **required** and can be any unique string
(use your order id). Retrying with the same key never double-issues — safe on
timeout/retry.

## Reading & lifecycle

```js
await ff.getInvoice(invoiceId);              // poll while status is QUEUED
await ff.listInvoices(1);                     // page 1
const pdf = await ff.download(invoiceId, "pdf"); // Uint8Array; or "html" / "xml"
await ff.cancel(invoiceId);                   // before GİB acceptance
```

## Errors

Failed calls throw a typed error carrying `.status` and `.body`:

| Class | HTTP | Meaning |
|-------|------|---------|
| `AuthError` | 401 | key missing/invalid/revoked/expired |
| `InsufficientCredits` | 402 | not enough credits (kontör) |
| `ScopeError` | 403 | key lacks the required scope |
| `OnboardingRequired` | 412 | e-invoice onboarding not completed |
| `ProviderError` | 5xx | transient upstream — retry same idempotency key |
| `FinansfaturaError` | other | base class |

```js
import { FinansfaturaError, OnboardingRequired } from "finansfatura";

try {
  await ff.issueInvoice(payload, `order-${order.id}`);
} catch (e) {
  if (e instanceof OnboardingRequired) {
    // e.body -> { error_code, message }
  } else if (e instanceof FinansfaturaError) {
    console.error(`issue failed [${e.status}]`, e.body);
  } else throw e;
}
```

## e-Fatura (registered recipients)

e-Arşiv targets final consumers (TCKN is fine). For a GİB-registered recipient
use e-Fatura, which needs the recipient's mailbox alias:

```js
import { buildEfaturaPayload } from "finansfatura";

const payload = buildEfaturaPayload(
  { vkn_tckn: "1234567890", title: "Kurum A.Ş." },
  [/* lines */],
  "urn:mail:defaultpk@example.com", // recipient alias (required)
);
```

## Notes

- Seller identity (`Issuer`) is filled server-side from your company profile —
  don't send it. Make sure the profile VKN is set, or issuing returns 503.
- Keep the API key in an env var; never commit it.

## Development

```bash
npm test   # node --test, no framework
```

## License

MIT
