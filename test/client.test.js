import { test } from "node:test";
import assert from "node:assert/strict";
import { FinansfaturaClient, InsufficientCredits } from "../src/index.js";

// Minimal fake fetch: records the last call, returns a canned Response-like object.
function fakeFetch(status, payload) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      status,
      json: () => (payload == null ? Promise.reject(new Error("no json")) : Promise.resolve(payload)),
      text: () => Promise.resolve("error"),
    });
  };
  fn.calls = calls;
  return fn;
}

test("issue sets idempotency header and returns json", async () => {
  const fetch = fakeFetch(200, { invoice_id: "abc", status: "QUEUED" });
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch });
  const out = await ff.issueInvoice({ document_type: "EARSIV" }, "order-1");
  assert.equal(out.status, "QUEUED");
  const { url, opts } = fetch.calls[0];
  assert.equal(opts.method, "POST");
  assert.ok(url.endsWith("/invoices/"));
  assert.equal(opts.headers["X-Api-Key"], "ff_live_x");
  assert.equal(opts.headers["Idempotency-Key"], "order-1");
});

test("error status maps to typed exception", async () => {
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch: fakeFetch(402, { message: "insufficient credits" }) });
  await assert.rejects(() => ff.issueInvoice({}, "order-2"), (e) => {
    assert.ok(e instanceof InsufficientCredits);
    assert.equal(e.status, 402);
    return true;
  });
});

test("missing idempotency key rejected client-side", async () => {
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch: fakeFetch(200, {}) });
  await assert.rejects(() => ff.issueInvoice({}, ""), /idempotencyKey is required/);
});

test("apiKey required", () => {
  assert.throws(() => new FinansfaturaClient({ apiKey: "" }), /apiKey is required/);
});
