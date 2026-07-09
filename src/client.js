// HTTP client for the Finansfatura e-invoice API.
//
//   import { FinansfaturaClient, buildEarsivPayload } from "finansfatura";
//
//   const ff = new FinansfaturaClient({ apiKey: "ff_live_..." });
//   const payload = buildEarsivPayload(
//     { vkn_tckn: "11111111111", title: "Ahmet Yılmaz" },
//     [{ title: "Kulaklık", qty: 1, unit_price: 100.0, vat_rate: 0.20 }],
//   );
//   const result = await ff.issueInvoice(payload, "order-1042");

import { errorFromResponse } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.finansfatura.com/v1/invoicing";

export class FinansfaturaClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - your `ff_live_...` / `ff_test_...` key (sent as X-Api-Key).
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeout] - per-request timeout in ms (default 15000).
   * @param {typeof fetch} [opts.fetch] - inject a fetch impl (real HTTP by default; fake in tests).
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeout = 15000, fetch: fetchImpl } = {}) {
    if (!apiKey) throw new Error("apiKey is required");
    this.apiKey = apiKey;
    this.base = baseUrl.replace(/\/+$/, "");
    this.timeout = timeout;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error("no fetch available — use Node 18+ or pass opts.fetch");
  }

  _headers(extra) {
    return { "X-Api-Key": this.apiKey, "Content-Type": "application/json", ...extra };
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

  /**
   * POST /invoices/ — issue a document. `idempotencyKey` (any unique string,
   * e.g. the order id) is required; retrying with the same key never double-issues.
   */
  async issueInvoice(payload, idempotencyKey) {
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const resp = await this._request("POST", "/invoices/", {
      body: payload,
      headers: { "Idempotency-Key": String(idempotencyKey) },
    });
    return resp.json();
  }

  /** GET /invoices/:id — one invoice (poll here while status is QUEUED). */
  async getInvoice(invoiceId) {
    const resp = await this._request("GET", `/invoices/${invoiceId}`);
    return resp.json();
  }

  /** GET /invoices/ — paginated list. */
  async listInvoices(page = 1) {
    const resp = await this._request("GET", "/invoices/", { query: { page } });
    return resp.json();
  }

  /**
   * GET /invoices/:id/download — raw document bytes (pdf|html|xml).
   * @returns {Promise<Uint8Array>}
   */
  async download(invoiceId, format = "pdf") {
    const resp = await this._request("GET", `/invoices/${invoiceId}/download`, {
      query: { format },
    });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** POST /invoices/:id/cancel — cancel before GİB acceptance. */
  async cancel(invoiceId) {
    await this._request("POST", `/invoices/${invoiceId}/cancel`);
    return true;
  }
}
