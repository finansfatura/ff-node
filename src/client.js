// HTTP client for the Finansfatura API.
//
// The integration is two steps: create the sale, then invoice it.
//
//   import { FinansfaturaClient, buildEarsivPayload } from "finansfatura";
//
//   const ff = new FinansfaturaClient({ apiKey: "ff_live_..." });
//
//   const sale = await ff.createOrder({
//     provider: "ECOMSOFT",
//     external_id: "ORD-1042",
//     total_price: 120.0,                          // KDV *dahil*
//     buyer: { title: "Ahmet Yılmaz", tckn: "11111111111" },
//     lines: [{ title: "Kulaklık", sku: "SKU-1042",
//               quantity: 1, unit_price: 120.0, vat_rate: 20 }],
//   });
//
//   const payload = buildEarsivPayload(
//     { vkn_tckn: "11111111111", title: "Ahmet Yılmaz" },
//     [{ title: "Kulaklık", qty: 1, unit_price: 100.0, vat_rate: 0.20 }],  // KDV *hariç*
//     { transactionHeaderId: sale.transaction_id },
//   );
//   const result = await ff.issueInvoice(payload, "ORD-1042");
//
// The order of the two is fixed and neither half is skippable mid-flow: the sale
// needs a `buyer` (it becomes the document's billing recipient, copied onto the
// sale), and the document needs the sale's `transaction_id`. Issuing the document at all
// is still your call: leave it out and the company invoices its sales from the panel.

import { errorFromResponse } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.finansfatura.com";
export const SANDBOX_BASE_URL = "https://sandbox-api.finansfatura.com";

/** the status endpoint takes at most this many ids per call */
export const MAX_STATUS_IDS = 50;

// Reject client-side what the server would reject anyway — one round trip saved,
// and the error names the field instead of arriving as a 400 body.
function validateOrder(order) {
  if (!order?.external_id) throw new Error("order.external_id is required");
  if (!order.lines?.length) throw new Error("order.lines must have at least one line");
  if (!order.buyer) {
    throw new Error("order.buyer is required — it is the document's billing recipient");
  }
  if (!order.buyer.title?.trim() && !order.buyer.contact_name?.trim()) {
    throw new Error("order.buyer needs 'title' (or 'contact_name') — it names the recipient");
  }
}

export class FinansfaturaClient {
  /**
   * Authenticate with either an API key (`X-Api-Key`, one company, pasted by the
   * taxpayer) or an OAuth access token (`Authorization: Bearer`, many companies,
   * see OAuth). Exactly one of the two.
   *
   * @param {object} opts
   * @param {string} [opts.apiKey] - your `ff_live_...` / `ff_test_...` key.
   * @param {string} [opts.accessToken] - an OAuth access token.
   * @param {string} [opts.baseUrl] - API host only; paths are built here.
   * @param {number} [opts.timeout] - per-request timeout in ms (default 15000).
   * @param {typeof fetch} [opts.fetch] - inject a fetch impl (real HTTP by default; fake in tests).
   */
  constructor({ apiKey, accessToken, baseUrl = DEFAULT_BASE_URL, timeout = 15000, fetch: fetchImpl } = {}) {
    if (!apiKey === !accessToken) throw new Error("pass exactly one of apiKey or accessToken");
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.base = baseUrl.replace(/\/+$/, "");
    this.timeout = timeout;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error("no fetch available — use Node 18+ or pass opts.fetch");
  }

  _headers(extra) {
    const auth = this.apiKey
      ? { "X-Api-Key": this.apiKey }
      : { Authorization: `Bearer ${this.accessToken}` };
    return { ...auth, "Content-Type": "application/json", ...extra };
  }

  async _request(method, path, { query, body, headers } = {}) {
    let url = `${this.base}${path}`;
    if (query) {
      const q = new URLSearchParams(query).toString();
      if (q) url += `?${q}`;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeout);
    let resp;
    try {
      resp = await this.fetch(url, {
        method,
        headers: this._headers(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (resp.status >= 400) {
      let errBody;
      try {
        errBody = await resp.json();
      } catch {
        errBody = await resp.text().catch(() => "");
      }
      throw errorFromResponse(resp.status, errBody);
    }
    return resp;
  }

  // -- sales -----------------------------------------------------------------

  /**
   * POST /v1/integrations/orders — turn an order into a sale.
   *
   * The first and mandatory step: the sale feeds the company's turnover and
   * stock, and survives a failed invoice attempt.
   *
   * `order` needs `external_id` (your stable order id — resending it never
   * duplicates the sale), at least one line, and a `buyer`. The buyer is copied
   * onto the sale as the document's billing recipient — no current account
   * ("cari") is created. Hence `title` (or `contact_name`) is required: it names
   * who the document is issued to.
   *
   * The rest is optional but each field lands on the document: `tckn` /
   * `tax_number` (one identity field there — `tax_number` wins if you send
   * both), `tax_office`, `address`, `phone` and `email`. Send the identity when
   * the channel has it, or the recipient cannot be looked up at GİB. Send the
   * e-mail too: on an e-Arşiv document GİB's mandatory delivery-type field is
   * derived from it (`ELEKTRONIK` with an address, `KAGIT` without).
   *
   * Prices here are KDV-INCLUSIVE and `vat_rate` is a percentage (`20`) — the
   * opposite of the invoice payload, which is KDV-exclusive with a ratio
   * (`0.20`). Mixing the two up is the most common integration bug.
   *
   * Resolves to the API body; `transaction_id` is the sale id to pass on to
   * `issueInvoice`, and `already_imported` tells you it was a repeat.
   */
  async createOrder(order) {
    validateOrder(order);
    const resp = await this._request("POST", "/v1/integrations/orders", { body: order });
    return resp.json();
  }

  /**
   * GET /v1/integrations/:provider/orders/status — bulk invoice status.
   *
   * `externalIds` is an array (or comma string) of your order ids, at most 50 per
   * call. Ids we never received are simply absent from the response, so match on
   * `external_id` instead of trusting the order.
   */
  async orderStatus(provider, externalIds) {
    const ids = (typeof externalIds === "string" ? externalIds.split(",") : [...externalIds]).filter(Boolean);
    if (!ids.length) throw new Error("externalIds is required");
    if (ids.length > MAX_STATUS_IDS) throw new Error(`at most ${MAX_STATUS_IDS} externalIds per call`);
    const resp = await this._request("GET", `/v1/integrations/${provider}/orders/status`, {
      query: { external_ids: ids.join(",") },
    });
    return resp.json();
  }

  // -- invoices --------------------------------------------------------------

  /**
   * POST /v1/invoicing/invoices/ — issue a document. `idempotencyKey` (any unique
   * string, e.g. the order id) is required; retrying with the same key never
   * double-issues and never charges credits twice.
   *
   * The invoice number is not in the response — read it from `orderStatus` once
   * the provider assigns it.
   */
  async issueInvoice(payload, idempotencyKey) {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const resp = await this._request("POST", "/v1/invoicing/invoices/", {
      body: payload,
      headers: { "Idempotency-Key": String(idempotencyKey) },
    });
    return resp.json();
  }

  /** GET /v1/invoicing/invoices/:id — one invoice. */
  async getInvoice(invoiceId) {
    const resp = await this._request("GET", `/v1/invoicing/invoices/${invoiceId}`);
    return resp.json();
  }

  /** GET /v1/invoicing/invoices/ — paginated list. */
  async listInvoices(page = 1, pageSize = 20) {
    const resp = await this._request("GET", "/v1/invoicing/invoices/", {
      query: { page, page_size: pageSize },
    });
    return resp.json();
  }

  /**
   * GET /v1/invoicing/invoices/:id/download — raw document bytes (pdf|html|xml).
   * @returns {Promise<Uint8Array>}
   */
  async download(invoiceId, format = "pdf") {
    const resp = await this._request("GET", `/v1/invoicing/invoices/${invoiceId}/download`, {
      query: { format },
    });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * POST /v1/invoicing/invoices/:id/cancel — e-Arşiv cancels outright; e-Fatura
   * starts a process that depends on the recipient.
   */
  async cancel(invoiceId) {
    await this._request("POST", `/v1/invoicing/invoices/${invoiceId}/cancel`);
    return true;
  }
}
