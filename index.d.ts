// Type declarations for the finansfatura e-invoice client.

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
}

export interface BuildOptions {
  issuer?: Party;
  recipientAlias?: string;
  invoiceTypeCode?: string;
  note?: string;
}

export interface IssuePayload {
  document_type: string;
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
  recipientAlias: string,
  opts?: BuildOptions,
): IssuePayload;

export const DEFAULT_BASE_URL: string;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** per-request timeout in ms (default 15000) */
  timeout?: number;
  /** inject a fetch implementation (real HTTP by default; fake in tests) */
  fetch?: typeof fetch;
}

export class FinansfaturaClient {
  constructor(opts: ClientOptions);
  apiKey: string;
  base: string;
  timeout: number;
  issueInvoice(payload: IssuePayload | object, idempotencyKey: string): Promise<any>;
  getInvoice(invoiceId: string): Promise<any>;
  listInvoices(page?: number): Promise<any>;
  download(invoiceId: string, format?: "pdf" | "html" | "xml"): Promise<Uint8Array>;
  cancel(invoiceId: string): Promise<true>;
}

export class FinansfaturaError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string);
}
export class AuthError extends FinansfaturaError {}
export class InsufficientCredits extends FinansfaturaError {}
export class ScopeError extends FinansfaturaError {}
export class OnboardingRequired extends FinansfaturaError {}
export class ProviderError extends FinansfaturaError {}
