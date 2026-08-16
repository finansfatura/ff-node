# finansfatura

Node client for the [Finansfatura](https://finansfatura.com) API — turn orders
into sales, issue e-Fatura / e-Arşiv documents, and follow their status.
Full API reference: [apidocs.finansfatura.com](https://apidocs.finansfatura.com).

Zero dependencies (native `fetch`, Node 18+). Ships with TypeScript types.

## Install

```bash
npm install finansfatura
```

## The flow

An integration is two steps, in this order:

```
1. createOrder()   POST /v1/integrations/orders     → transaction_id
2. issueInvoice()  POST /v1/invoicing/invoices/     → invoice_id
   orderStatus()   GET  /v1/integrations/…/status   → invoice_number
```

Step 2 is **optional** — if you only push sales, the taxpayer invoices them from
the panel, one by one or in bulk. That is the smoothest start for most
integrations.

Step 1 is not optional. It is what puts the order in the turnover report, the
current account and the stock, and what keeps the order alive when invoicing
fails (no credits, bad VKN, GİB down).

## Quickstart

```js
import { FinansfaturaClient, buildEarsivPayload } from "finansfatura";

const ff = new FinansfaturaClient({ apiKey: process.env.FINANSFATURA_API_KEY }); // ff_live_...

// 1 — the sale. Prices KDV-INCLUSIVE, vat_rate as a percentage.
const sale = await ff.createOrder({
  provider: "ECOMSOFT",             // your brand; unknown values show as FINANSFATURA
  external_id: "ORD-2026-00184",    // your stable order id
  order_number: "184",
  payment_status: "PAID",
  currency: "TRY",
  total_price: 120.0,
  buyer: {
    title: "Ahmet Yılmaz",
    tckn: "11111111111",
    email: "ahmet@example.com",
    address: "Kadıköy / İstanbul",
  },
  lines: [{
    sku: "SKU-1042", title: "Kablosuz Kulaklık",
    quantity: 1, unit_price: 120.0, total_price: 120.0, vat_rate: 20,
  }],
});

// 2 — the invoice. Prices KDV-EXCLUSIVE, vat_rate as a ratio.
const payload = buildEarsivPayload(
  { vkn_tckn: "11111111111", title: "Ahmet Yılmaz" },
  [{ title: "Kablosuz Kulaklık", product_code: "SKU-1042", qty: 1, unit_price: 100.0, vat_rate: 0.20 }],
  { transactionHeaderId: sale.transaction_id },
);

const result = await ff.issueInvoice(payload, "ORD-2026-00184");
console.log(result.invoice_id, result.status); // -> ... QUEUED
```

> **The two endpoints disagree about VAT on purpose.** The order body carries
> KDV-**inclusive** prices with a percentage (`120`, `20`); the invoice body
> carries KDV-**exclusive** prices with a ratio (`100`, `0.20`). This is the most
> common integration bug — the builders keep the invoice side honest, the order
> side is yours.

`transactionHeaderId` links the invoice to the sale. Without it the invoice
exists but the sale does not know about it: no turnover, no current account, no
stock movement.

### Sandbox

```js
import { SANDBOX_BASE_URL } from "finansfatura";

const ff = new FinansfaturaClient({ apiKey: "ff_test_...", baseUrl: SANDBOX_BASE_URL });
```

Sandbox and production are entirely separate systems — keys, OAuth clients and
data never cross over.

### About the builders

`buildEarsivPayload` computes totals from the lines (exact decimal, no float
kuruş drift) and applies the API's exact field casing for you: the outer layer is
snake_case (`document_type`, `canonical`) but everything inside `canonical` is
PascalCase (`Recipient`, `Lines`, `Totals`, `VKNorTCKN`). A snake_case key inside
`canonical` is silently ignored by the server, so let the builder handle it.

For exact money you may pass `qty` / `unit_price` / `vat_rate` as strings
(`"33.33"`) — numbers work too, the builder rounds half-even to the kuruş.

## Idempotency

The second argument to `issueInvoice` is **required** and can be any unique string
(use your order id). Retrying with the same key never double-issues and never
charges credits twice. Likewise, resending the same `external_id` to
`createOrder` never duplicates the sale — you get `200` with
`already_imported: true` instead of `201`. Both are what make retries safe.

## Following the status

The invoice number is **not** in the issue response — the provider assigns it a
moment later. Read it from the bulk status endpoint:

```js
const { statuses } = await ff.orderStatus("ecomsoft", ["ORD-2026-00184", "ORD-2026-00185"]);
for (const s of statuses) console.log(s.external_id, s.invoice_status, s.invoice_number);
```

Up to 50 ids per call. Orders we never received are simply absent from the
response, so match on `external_id` — don't trust the order. Statuses are
`NOT_INVOICED`, `QUEUED`, `ISSUED`, `ACCEPTED`, `REJECTED`, `CANCELLED`; the last
three are final.

Check once in the first minute after issuing, then every few minutes for the
records that are not final yet. Polling faster does not make GİB answer sooner.

## Reading & lifecycle

```js
await ff.getInvoice(invoiceId);
await ff.listInvoices(1, 20);                    // page, page size
const pdf = await ff.download(invoiceId, "pdf"); // Uint8Array; or "html" / "xml"
await ff.cancel(invoiceId);                      // e-Arşiv outright; e-Fatura is a process
```

## Errors

Failed calls throw a typed error carrying `.status`, `.body` and `.retryable`:

| Class | HTTP | Meaning | Retry |
|-------|------|---------|-------|
| `ValidationError` | 400, 422 | bad body — `.body.errors` names the fields | ❌ |
| `AuthError` | 401 | key/token missing, invalid, revoked or expired | ❌ |
| `InsufficientCredits` | 402 | not enough credits (kontör) | ❌ |
| `ScopeError` | 403 | missing scope, or endpoint closed to API keys | ❌ |
| `OnboardingRequired` | 412 | the taxpayer's e-invoice setup is unfinished | ❌ |
| `RateLimitError` | 429 | too many requests | ✅ |
| `ProviderError` | 5xx | transient upstream / provider unreachable | ✅ |
| `FinansfaturaError` | other | base class | — |

```js
import { FinansfaturaError, OnboardingRequired } from "finansfatura";

try {
  await ff.issueInvoice(payload, `order-${order.id}`);
} catch (e) {
  if (e instanceof OnboardingRequired) {
    // The sale is safe. Tell the merchant to finish setup in the panel; the
    // pending sales can be invoiced later.
  } else if (e instanceof FinansfaturaError) {
    if (e.retryable) scheduleRetry(order.id);    // 1s, 2s, 4s, 8s …
    else console.error(`issue failed [${e.status}]`, e.body);
  } else throw e;
}
```

## e-Fatura vs e-Arşiv

Send `EARSIV` and let the server correct it. When `RecipientAlias` is left empty
(the default), we ask GİB about the recipient's VKN: registered taxpayers are
upgraded to `EFATURA` with the mailbox alias resolved, everyone else stays
`EARSIV`. You don't need to run the lookup yourself.

```js
import { buildEfaturaPayload } from "finansfatura";

const payload = buildEfaturaPayload(
  { vkn_tckn: "1234567890", title: "Kurum A.Ş." },
  [/* lines */],
  // "urn:mail:defaultpk@example.com",   // only if you already know the alias
);
```

Other document types (`EIRSALIYE`, `ESMM`, `EMM`, `EADISYON`) go through
`buildPayload(documentType, ...)`.

## OAuth 2.0

API keys bind to one company. If your product serves many taxpayers, register an
OAuth client (partner@finansfatura.com) and drop the copy-paste step:

```js
import { FinansfaturaClient, OAuth, generatePkce } from "finansfatura";

const oauth = new OAuth({ clientId, clientSecret, redirectUri: "https://app.example.com/ff/callback" });

// 1 — send the taxpayer to the consent screen
const { verifier, challenge } = generatePkce();   // keep `verifier` in the session
req.session.ffVerifier = verifier;
res.redirect(oauth.authorizeUrl({ codeChallenge: challenge, state: csrfToken }));

// 2 — the callback comes back with ?code=…
const token = await oauth.exchangeCode(req.query.code, { codeVerifier: req.session.ffVerifier });
await store(token.access_token, token.refresh_token, token.expires_in);

// 3 — use it
const ff = new FinansfaturaClient({ accessToken: token.access_token });
```

```js
const fresh = await oauth.refresh(storedRefreshToken);  // store the NEW refresh token
await oauth.revoke(storedRefreshToken);                 // end the connection
```

- `redirectUri` must match a registered address **exactly**; partial matches are
  rejected.
- Every refresh invalidates the previous refresh token. Persist the newest one or
  the connection dies.
- Scopes: `invoice:read` (status/reads) and `invoice:write` (sales, issuing,
  cancelling). Ask only for what you use.
- Token and revoke URLs keep their **trailing slash** — the client handles it.

## Notes

- Seller identity (`Issuer`) is filled server-side from your company profile —
  don't send it. Make sure the profile VKN is set, or issuing returns 503.
- Keep the API key server-side and encrypted; it acts on the taxpayer's company.
  Never ship it to a browser or mobile app.
- `baseUrl` is the API host only (`https://api.finansfatura.com`) — paths are
  built by the client. Since 0.2.0 it no longer includes `/v1/invoicing`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm test   # node --test, no framework
```

## License

MIT
