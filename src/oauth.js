// OAuth 2.0 authorization code flow (RFC 6749) with PKCE.
//
// Use this instead of API keys when your product serves many taxpayers: they
// click "connect" in your app, approve the consent screen, and you get a token —
// no copy-pasted key.
//
//   import { FinansfaturaClient, OAuth, generatePkce } from "finansfatura";
//
//   const oauth = new OAuth({ clientId, clientSecret,
//                             redirectUri: "https://app.example.com/ff/callback" });
//
//   const { verifier, challenge } = generatePkce();   // keep verifier in the session
//   res.redirect(oauth.authorizeUrl({ codeChallenge: challenge, state: csrfToken }));
//
//   // ... taxpayer approves, we get ?code=... on the redirectUri ...
//   const token = await oauth.exchangeCode(code, { codeVerifier: verifier });
//   const ff = new FinansfaturaClient({ accessToken: token.access_token });
//
// Every refresh invalidates the previous refresh token — always persist the
// newest one you were handed.

import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_BASE_URL, SANDBOX_BASE_URL } from "./client.js";
import { errorFromResponse } from "./errors.js";

/** where the taxpayer approves the connection (panel, not API) */
export const AUTHORIZE_BASE_URL = "https://app.finansfatura.com";
export const SANDBOX_AUTHORIZE_BASE_URL = "https://sandbox-app.finansfatura.com";

export const DEFAULT_SCOPE = "invoice:read invoice:write";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Generate a `{ verifier, challenge }` pair for PKCE `S256`.
 *
 * Keep the verifier server-side until the callback comes back; send only the
 * challenge to the authorize URL.
 */
export function generatePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * The three OAuth calls, with your client credentials bound once.
 *
 * Get `clientId` / `clientSecret` and register your `redirectUri` through
 * partner@finansfatura.com.
 */
export class OAuth {
  constructor({
    clientId,
    clientSecret,
    redirectUri,
    baseUrl = DEFAULT_BASE_URL,
    authorizeBaseUrl,
    timeout = 15000,
    fetch: fetchImpl,
  } = {}) {
    if (!clientId) throw new Error("clientId is required");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.base = baseUrl.replace(/\/+$/, "");
    // sandbox api ⇒ sandbox panel, so callers only override one url
    this.authorizeBase = (
      authorizeBaseUrl ||
      (this.base === SANDBOX_BASE_URL ? SANDBOX_AUTHORIZE_BASE_URL : AUTHORIZE_BASE_URL)
    ).replace(/\/+$/, "");
    this.timeout = timeout;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error("no fetch available — use Node 18+ or pass opts.fetch");
  }

  /**
   * Build the consent-screen URL to send the taxpayer to.
   *
   * `redirectUri` must match one of your registered addresses exactly; partial
   * matches are rejected. Requested scopes must be a subset of the ones granted
   * to your client.
   */
  authorizeUrl({ codeChallenge, state, scope = DEFAULT_SCOPE, redirectUri } = {}) {
    const redirect = redirectUri || this.redirectUri;
    if (!redirect) throw new Error("redirectUri is required");
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope,
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }
    if (state) params.set("state", state);
    return `${this.authorizeBase}/oauth/authorize?${params}`;
  }

  /** POST /v1/oauth/token/ — trade the callback `code` for tokens. */
  async exchangeCode(code, { codeVerifier, redirectUri } = {}) {
    return this._token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri || this.redirectUri,
      code_verifier: codeVerifier,
    });
  }

  /**
   * POST /v1/oauth/token/ — swap a refresh token for a fresh pair. The old
   * refresh token dies here; store the one you get back.
   */
  async refresh(refreshToken) {
    return this._token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** POST /v1/oauth/revoke/ — end the connection from your side. */
  async revoke(token) {
    // trailing slash is mandatory — the slashless form is not redirected
    await this._post("/v1/oauth/revoke/", { token });
    return true;
  }

  // -- internals -------------------------------------------------------------

  async _token(form) {
    const resp = await this._post("/v1/oauth/token/", form);
    return resp.json();
  }

  async _post(path, form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v) body.set(k, v);
    body.set("client_id", this.clientId);
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeout);
    let resp;
    try {
      resp = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
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
}
