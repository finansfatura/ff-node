import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FinansfaturaClient,
  InsufficientCredits,
  OAuth,
  RateLimitError,
  SANDBOX_BASE_URL,
  ValidationError,
  generatePkce,
} from "../src/index.js";

// A minimally valid order: id, one line, and a buyer that names the cari.
const order = (over = {}) => ({
  external_id: "ORD-1",
  buyer: { title: "Ahmet Yılmaz", tckn: "11111111111" },
  lines: [{ title: "A", quantity: 1, unit_price: 120.0, vat_rate: 20 }],
  ...over,
});

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

test("exactly one credential required", () => {
  assert.throws(() => new FinansfaturaClient({ apiKey: "" }), /exactly one/);
  assert.throws(() => new FinansfaturaClient({ apiKey: "k", accessToken: "t" }), /exactly one/);
});

test("access token sends bearer, not api key", async () => {
  const fetch = fakeFetch(200, { statuses: [] });
  const ff = new FinansfaturaClient({ accessToken: "at_123", fetch });
  await ff.orderStatus("ecomsoft", ["A"]);
  const { opts } = fetch.calls[0];
  assert.equal(opts.headers.Authorization, "Bearer at_123");
  assert.equal(opts.headers["X-Api-Key"], undefined);
});

test("createOrder hits the integrations path", async () => {
  const fetch = fakeFetch(201, { imported: true, transaction_id: "t-1" });
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch });
  const out = await ff.createOrder(order());
  assert.equal(out.transaction_id, "t-1");
  const { url, opts } = fetch.calls[0];
  assert.equal(opts.method, "POST");
  assert.ok(url.endsWith("/v1/integrations/orders"));
});

test("createOrder needs a buyer to hang the cari off", async () => {
  const fetch = fakeFetch(201, {});
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch });

  for (const bad of [order({ external_id: "" }), order({ lines: [] }),
                     order({ buyer: undefined }), order({ buyer: { email: "a@b.c" } })]) {
    await assert.rejects(() => ff.createOrder(bad), /is required|must have at least one line|names the cari/);
  }
  // rejected before the request — no round trip burned on a known-bad body
  assert.equal(fetch.calls.length, 0);
  // contact_name stands in for title: it is what names the cari
  await ff.createOrder(order({ buyer: { contact_name: "Ahmet Yılmaz" } }));
  assert.equal(fetch.calls.length, 1);
});

test("orderStatus joins ids and caps at 50", async () => {
  const fetch = fakeFetch(200, { statuses: [] });
  const ff = new FinansfaturaClient({ apiKey: "ff_live_x", fetch });
  await ff.orderStatus("ecomsoft", ["ORD-1", "ORD-2"]);
  const { url, opts } = fetch.calls[0];
  assert.equal(opts.method, "GET");
  assert.ok(url.includes("/v1/integrations/ecomsoft/orders/status?"));
  assert.ok(url.endsWith("external_ids=ORD-1%2CORD-2"));

  const tooMany = Array.from({ length: 51 }, (_, i) => String(i));
  await assert.rejects(() => ff.orderStatus("ecomsoft", tooMany), /at most 50/);
  await assert.rejects(() => ff.orderStatus("ecomsoft", []), /required/);
});

test("429 is retryable, 400 is not", async () => {
  const rateLimited = new FinansfaturaClient({ apiKey: "k", fetch: fakeFetch(429, { message: "slow down" }) });
  await assert.rejects(() => rateLimited.createOrder(order()), (e) => {
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.retryable, true);
    return true;
  });

  const bad = new FinansfaturaClient({ apiKey: "k", fetch: fakeFetch(400, { message: "validation error" }) });
  await assert.rejects(() => bad.createOrder(order()), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.retryable, false);
    return true;
  });
});

test("pkce pair is url-safe and verifiable", async () => {
  const { createHash } = await import("node:crypto");
  const { verifier, challenge } = generatePkce();
  assert.ok(!/[+/=]/.test(verifier + challenge));
  const expected = createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(challenge, expected);
});

test("authorize url carries pkce and state", () => {
  const oauth = new OAuth({
    clientId: "cid",
    clientSecret: "sec",
    redirectUri: "https://app.example.com/cb",
    fetch: fakeFetch(200, {}),
  });
  const url = oauth.authorizeUrl({ codeChallenge: "chal", state: "xyz" });
  assert.ok(url.startsWith("https://app.finansfatura.com/oauth/authorize?"));
  assert.ok(url.includes("code_challenge=chal"));
  assert.ok(url.includes("code_challenge_method=S256"));
  assert.ok(url.includes("response_type=code"));
  assert.ok(url.includes("state=xyz"));
});

test("sandbox api url implies sandbox panel", () => {
  const oauth = new OAuth({
    clientId: "cid",
    baseUrl: SANDBOX_BASE_URL,
    redirectUri: "https://app.example.com/cb",
    fetch: fakeFetch(200, {}),
  });
  assert.ok(oauth.authorizeUrl().startsWith("https://sandbox-app.finansfatura.com/"));
});

test("token endpoints keep their trailing slash and post a form", async () => {
  const fetch = fakeFetch(200, { access_token: "at", refresh_token: "rt" });
  const oauth = new OAuth({
    clientId: "cid",
    clientSecret: "sec",
    redirectUri: "https://app.example.com/cb",
    fetch,
  });

  const token = await oauth.exchangeCode("the-code", { codeVerifier: "ver" });
  assert.equal(token.access_token, "at");
  const exchange = fetch.calls[0];
  assert.ok(exchange.url.endsWith("/v1/oauth/token/"));
  assert.equal(exchange.opts.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(exchange.opts.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "ver");
  assert.equal(form.get("client_secret"), "sec");

  await oauth.revoke("rt");
  const revoke = fetch.calls[1];
  assert.ok(revoke.url.endsWith("/v1/oauth/revoke/"));
  assert.equal(new URLSearchParams(revoke.opts.body).get("token"), "rt");
});
