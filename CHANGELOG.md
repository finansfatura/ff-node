# Changelog

Notable changes per release. Versions follow [semver](https://semver.org);
while below 1.0 a breaking change bumps the minor.

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
