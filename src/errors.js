// Typed errors for the Finansfatura API.
//
// Every failed HTTP call throws a FinansfaturaError (or a subclass) carrying the
// HTTP `status` and the parsed `body`, so callers branch on the kind of failure
// with `instanceof` instead of inspecting status codes by hand.

export class FinansfaturaError extends Error {
  constructor(status, body, message) {
    super(message || `[${status}] ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
  }
}

/** 401 — API key missing, invalid, revoked or expired. */
export class AuthError extends FinansfaturaError {}
/** 402 — not enough credits (kontör) to issue the document. */
export class InsufficientCredits extends FinansfaturaError {}
/** 403 — the API key lacks the required scope (e.g. invoice:write). */
export class ScopeError extends FinansfaturaError {}
/** 412 — e-invoice onboarding not completed. Body carries error_code/message. */
export class OnboardingRequired extends FinansfaturaError {}
/** 5xx — gateway/provider or transient upstream. Safe to retry with the same Idempotency-Key. */
export class ProviderError extends FinansfaturaError {}

const BY_STATUS = {
  401: AuthError,
  402: InsufficientCredits,
  403: ScopeError,
  412: OnboardingRequired,
};

export function errorFromResponse(status, body) {
  const Cls = BY_STATUS[status] || (status >= 500 ? ProviderError : FinansfaturaError);
  return new Cls(status, body);
}
