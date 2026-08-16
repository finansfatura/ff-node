// Typed errors for the Finansfatura API.
//
// Every failed HTTP call throws a FinansfaturaError (or a subclass) carrying the
// HTTP `status` and the parsed `body`, so callers branch on the kind of failure
// with `instanceof` instead of inspecting status codes by hand.
//
// `.retryable` encodes the API's retry table: 429/5xx are worth retrying with
// backoff, everything else needs the request fixed first.

export class FinansfaturaError extends Error {
  constructor(status, body, message) {
    super(message || `[${status}] ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
    this.retryable = false;
  }
}

/** 400 / 422 — bad request body. `body.errors` lists the offending fields. */
export class ValidationError extends FinansfaturaError {}
/** 401 — key/token missing, invalid, revoked or expired. */
export class AuthError extends FinansfaturaError {}
/** 402 — not enough credits (kontör) to issue the document. */
export class InsufficientCredits extends FinansfaturaError {}
/** 403 — missing scope (invoice:read / invoice:write), or the endpoint is closed
 *  to API keys entirely (ERROR_API_KEY_NOT_ALLOWED). */
export class ScopeError extends FinansfaturaError {}
/** 412 — e-invoice onboarding not finished. Invoicing fails but `createOrder`
 *  still works; the pending sales can be invoiced later. */
export class OnboardingRequired extends FinansfaturaError {}
/** 429 — too many requests. Back off and retry. */
export class RateLimitError extends FinansfaturaError {
  constructor(...args) {
    super(...args);
    this.retryable = true;
  }
}
/** 5xx — gateway/provider or transient upstream. Safe to retry with the same Idempotency-Key. */
export class ProviderError extends FinansfaturaError {
  constructor(...args) {
    super(...args);
    this.retryable = true;
  }
}

const BY_STATUS = {
  400: ValidationError,
  401: AuthError,
  402: InsufficientCredits,
  403: ScopeError,
  412: OnboardingRequired,
  422: ValidationError,
  429: RateLimitError,
};

export function errorFromResponse(status, body) {
  const Cls = BY_STATUS[status] || (status >= 500 ? ProviderError : FinansfaturaError);
  return new Cls(status, body);
}
