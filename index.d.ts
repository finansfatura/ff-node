// Type declarations for the finansfatura client.

/** A buyer (recipient) or seller (issuer). `vkn_tckn` is required: 10-digit VKN
 *  for a company, 11-digit TCKN for an individual. */
export interface Party {
  vkn_tckn: string;
  title?: string;
  address?: string;
  tax_office?: string;
  email?: string;
  phone?: string;
}

/** One invoice line. `unit_price` is KDV-excl; `vat_rate` is a decimal ratio
 *  (0.20 == %20). Numbers may also be passed as decimal strings for exact money. */
export interface Line {
  title: string;
  qty: number | string;
  unit_price: number | string;
  vat_rate: number | string;
  product_code?: string;
  unit_code?: string;
  /**
   * TEVKİFAT — GİB code (6xx partial, 8xx opt-in full). The RATE is not sent:
   * each code's legal rate is fixed and the server derives it from the code
   * (612 went from 7/10 to 9/10 in 2023).
   */
  withholding_code?: string;
  withholding_name?: string;
  /**
   * ÖZEL MATRAH — the base VAT is computed on, when it differs from the line's
   * own net (second-hand vehicles, jewellery, phone cards). Not to be confused
   * with an exemption: there is VAT here, it is just computed on this base.
   */
  tax_base_amount?: number;
  tax_base_code?: string;
  tax_base_reason?: string;
}

export interface BuildOptions {
  /** the `transaction_id` from `createOrder()`. REQUIRED — every document hangs
   *  off a sale (turnover, current account, stock all key off it); the builder
   *  throws without it. Optional here only for the one exception:
   *  `invoiceTypeCode: "IADE"`, which must NOT be attached or the sale counts
   *  twice. */
  transactionHeaderId?: string;
  issuer?: Party;
  /** leave empty: the server resolves the GİB mailbox from the VKN. */
  recipientAlias?: string;
  /** "SATIS" (default) or "IADE" — the only value that waives the sale link. */
  invoiceTypeCode?: string;
  note?: string;
  /**
   * VAT-exemption reason for zero-VAT lines (GİB code list, e.g. "301"). Both
   * are required when any line has `vat_rate: 0` — GİB rejects a zero-VAT line
   * without a reason. Document-level: applied only to the zero-VAT lines.
   */
  exemptionCode?: string;
  exemptionReason?: string;
  /**
   * e-Fatura scenario, `EFATURA` only: `TEMELFATURA` (recipient cannot answer,
   * the document is final) or `TICARIFATURA` (recipient may send KABUL/RED
   * within 8 days — the default). Legal difference, not cosmetic.
   */
  scenario?: "TEMELFATURA" | "TICARIFATURA";
  /**
   * The invoice a refund refunds. Required when `invoiceTypeCode` is
   * `IADE`/`TEVKIFATIADE`/`YTBIADE` — GİB rejects a refund without it.
   */
  returnInfo?: { number: string; issue_date: string };
  /** Document currency; only meaningful on a refund (a sale takes it from the sale). */
  currency?: string;
  /** TL value of one unit of `currency` — required when `currency` is not TRY. */
  exchangeRate?: number;
  exchangeRateDate?: string;
}

export interface IssuePayload {
  document_type: string;
  transaction_header_id?: string;
  canonical: Record<string, unknown>;
}

export function buildPayload(
  documentType: string,
  recipient: Party,
  lines: Line[],
  opts?: BuildOptions,
): IssuePayload;

export function buildEarsivPayload(recipient: Party, lines: Line[], opts?: BuildOptions): IssuePayload;

export function buildEfaturaPayload(
  recipient: Party,
  lines: Line[],
  recipientAlias?: string,
  opts?: BuildOptions,
): IssuePayload;

/** One line of an order. Prices are KDV-INCLUSIVE and `vat_rate` is a percentage
 *  (`20`) — the opposite of an invoice line. */
export interface OrderLine {
  title: string;
  quantity: number;
  sku?: string;
  /** matched before `sku` when both are present. */
  barcode?: string;
  external_line_id?: string;
  unit_price?: number;
  total_price?: number;
  vat_rate?: number;
  discount?: number;
}

/** The buyer is copied onto the sale as the document's billing recipient — no
 *  current account ("cari") is created. `title` (or `contact_name`) is what
 *  names the recipient, so one of the two is required.
 *
 *  `tckn` and `tax_number` are two fields here and ONE on the document
 *  (`tax_number` wins when both are sent); send whichever your channel holds,
 *  or a registered e-Fatura recipient cannot be looked up at GİB. `email` is
 *  worth sending too: on an e-Arşiv document GİB's mandatory delivery-type
 *  field is `ELEKTRONIK` with an address and `KAGIT` without. */
export interface OrderBuyer {
  title?: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  tckn?: string;
  tax_number?: string;
  tax_office?: string;
  address?: string;
}

export interface Order {
  /** your stable order id — resending it never duplicates the sale. */
  external_id: string;
  lines: OrderLine[];
  /** your brand; unregistered values show up as FINANSFATURA. */
  provider?: string;
  order_number?: string;
  customer_name?: string;
  /** RFC 3339; defaults to the request time. */
  ordered_at?: string;
  status?: string;
  payment_status?: "PAID" | "PENDING";
  currency?: string;
  total_price?: number;
  /**
   * VAT-exemption reason (GİB code, e.g. "301") — DOCUMENT-level, not per line.
   * Needed when any line has `vat_rate: 0`: without it the sale is still
   * recorded but its invoice cannot be issued. Stored on the sale and read at
   * issuance.
   */
  invoice_exemption_code?: string;
  invoice_exemption_reason?: string;
  /** required — the document's billing recipient. */
  buyer: OrderBuyer;
  [key: string]: unknown;
}

export interface OrderResult {
  imported: boolean;
  /** true means it was a repeat — a 200, not a 201. Not an error. */
  already_imported: boolean;
  integration_id?: number;
  external_id: string;
  /** the sale id; pass it as `transactionHeaderId` when invoicing. */
  transaction_id: string;
  [key: string]: unknown;
}

export type InvoiceStatus =
  | "NOT_INVOICED"
  | "QUEUED"
  | "ISSUED"
  | "ACCEPTED"
  | "REJECTED"
  | "CANCELLED";

export interface OrderStatusEntry {
  external_id: string;
  transaction_id?: string;
  invoice_status: InvoiceStatus;
  invoice_id?: string;
  /** filled a short while after issuing — not present in the issue response. */
  invoice_number?: string;
  document_type?: string;
  pdf_url?: string;
  invoiced_at?: string;
  [key: string]: unknown;
}

/** Orders we never received are absent — match on `external_id`, not order. */
export interface OrderStatusResult {
  statuses: OrderStatusEntry[];
}

export const DEFAULT_BASE_URL: string;
export const SANDBOX_BASE_URL: string;
export const MAX_STATUS_IDS: number;

export interface ClientOptions {
  /** an API key (one company) — mutually exclusive with `accessToken`. */
  apiKey?: string;
  /** an OAuth access token (many companies) — mutually exclusive with `apiKey`. */
  accessToken?: string;
  /** API host only; paths are built by the client. */
  baseUrl?: string;
  /** per-request timeout in ms (default 15000) */
  timeout?: number;
  /** inject a fetch implementation (real HTTP by default; fake in tests) */
  fetch?: typeof fetch;
}

export class FinansfaturaClient {
  constructor(opts: ClientOptions);
  apiKey?: string;
  accessToken?: string;
  base: string;
  timeout: number;
  createOrder(order: Order): Promise<OrderResult>;
  orderStatus(provider: string, externalIds: string[] | string): Promise<OrderStatusResult>;
  issueInvoice(payload: IssuePayload | object, idempotencyKey: string): Promise<any>;
  getInvoice(invoiceId: string): Promise<any>;
  listInvoices(page?: number, pageSize?: number): Promise<any>;
  download(invoiceId: string, format?: "pdf" | "html" | "xml"): Promise<Uint8Array>;
  cancel(invoiceId: string): Promise<true>;
}

export const AUTHORIZE_BASE_URL: string;
export const SANDBOX_AUTHORIZE_BASE_URL: string;
export const DEFAULT_SCOPE: string;

export interface OAuthOptions {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
  /** panel host for the consent screen; derived from `baseUrl` by default. */
  authorizeBaseUrl?: string;
  timeout?: number;
  fetch?: typeof fetch;
}

export interface AuthorizeUrlOptions {
  codeChallenge?: string;
  state?: string;
  scope?: string;
  redirectUri?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  /** every refresh invalidates the previous one — persist the newest. */
  refresh_token: string;
  scope: string;
  [key: string]: unknown;
}

export function generatePkce(): { verifier: string; challenge: string };

export class OAuth {
  constructor(opts: OAuthOptions);
  clientId: string;
  base: string;
  authorizeBase: string;
  authorizeUrl(opts?: AuthorizeUrlOptions): string;
  exchangeCode(code: string, opts?: { codeVerifier?: string; redirectUri?: string }): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  revoke(token: string): Promise<true>;
}

export class FinansfaturaError extends Error {
  status: number;
  body: unknown;
  /** true for 429/5xx — back off and retry; false means fix the request. */
  retryable: boolean;
  constructor(status: number, body: unknown, message?: string);
}
export class ValidationError extends FinansfaturaError {}
export class AuthError extends FinansfaturaError {}
export class InsufficientCredits extends FinansfaturaError {}
export class ScopeError extends FinansfaturaError {}
export class OnboardingRequired extends FinansfaturaError {}
export class RateLimitError extends FinansfaturaError {}
export class ProviderError extends FinansfaturaError {}
