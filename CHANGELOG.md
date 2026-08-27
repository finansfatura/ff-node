# Changelog

Notable changes per release. Versions follow [semver](https://semver.org);
while below 1.0 a breaking change bumps the minor.

## [0.3.0] — 2026-08-27

The sale, and the cari behind it, are no longer optional. Both halves are now
enforced client-side, before the request, matching what the API enforces.

### Changed — BREAKING

- `createOrder()` requires `buyer` with a `title` (or `contact_name`). The buyer is what
  the sale's current account ("cari") is resolved from: matched on `tax_number` →
  `tckn` → `email` → `title`, and created when nothing matches. A sale without one
  used to be accepted and left carisiz; the API now rejects it.
- `buildPayload()` (and the `buildEarsivPayload` / `buildEfaturaPayload` wrappers) requires `transactionHeaderId`. Every document hangs off a sale — that is what feeds
  the turnover report, the current account and stock. The one exception is a
  refund (`invoiceTypeCode:` `IADE`), which stays unattached so the sale is not counted twice.
- `createOrder()` also rejects a missing `external_id` or empty `lines` up front, instead
  of spending a round trip on a known 400.

## [0.2.0] — 2026-08-16

The client only covered invoicing; the API expects the sale to exist first.

### Added

- `createOrder()` — `POST /v1/integrations/orders`, the mandatory first step.
  Prices there are KDV-**inclusive** with a percentage `vat_rate`, the opposite
  of the invoice payload.
- `orderStatus()` — bulk invoice status for up to 50 `external_id`s. This is
  where `invoice_number` shows up; the issue response never carries it.
- `transactionHeaderId` build option, linking the invoice to its sale (turnover
  report, current account, stock).
- OAuth 2.0: `OAuth` (authorize URL, `exchangeCode`, `refresh`, `revoke`) and
  `generatePkce()`. `new FinansfaturaClient({ accessToken })` sends
  `Authorization: Bearer` instead of `X-Api-Key`.
- `ValidationError` (400/422) and `RateLimitError` (429).
- `.retryable` on every error, encoding the API's retry table.
- `SANDBOX_BASE_URL`, `MAX_STATUS_IDS`.
- `pageSize` on `listInvoices()`.
- Types for orders, statuses and the whole OAuth surface.

### Changed

- **Breaking:** `DEFAULT_BASE_URL` is the API host only
  (`https://api.finansfatura.com`); paths are built by the client. If you passed
  a custom `baseUrl` ending in `/v1/invoicing`, drop that suffix.
- `recipientAlias` is optional in `buildEfaturaPayload()` and always sent (as
  `""` when unknown) — that empty value is what makes the server resolve the GİB
  mailbox and upgrade `EARSIV` to `EFATURA` by itself.
- `FinansfaturaClient` requires exactly one of `apiKey` / `accessToken`.

## [0.1.1] — 2026-07-09

First release: `issueInvoice`, `getInvoice`, `listInvoices`, `download`,
`cancel`, the `canonical` payload builders with exact decimal totals, typed
errors and TypeScript declarations. Zero dependencies.
