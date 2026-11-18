/**
 * What a publish failure means for retries and for the account. Postiz turns platform errors
 * into readable messages (provider handleErrors(): 'refresh-token' | 'bad-body' | 'retry');
 * we classify the message text and HTTP status we get back.
 */
export type FailureKind = "auth" | "content" | "transient";

export interface FailureClass {
  kind: FailureKind;
  retryable: boolean;
  /** the connected account needs reconnecting */
  reconnect: boolean;
}

const AUTH = /re-?authenticat|access token|token (?:has )?expired|revoked|invalid_grant|unauthori[sz]ed|reconnect|permission(?:s)? (?:was|were|has been) (?:removed|revoked)|session has expired/i;
const TRANSIENT = /rate.?limit|too many requests|temporar|unavailable|timed? ?out|try again|service unavailable|internal server error|bad gateway|ECONNRESET|ETIMEDOUT|socket hang up|unable to obtain activity/i;

export function classifyFailure(message: string, status?: number): FailureClass {
  if (status === 401 || AUTH.test(message)) return { kind: "auth", retryable: false, reconnect: true };
  if (status === 429 || (status !== undefined && status >= 500) || TRANSIENT.test(message)) return { kind: "transient", retryable: true, reconnect: false };
  return { kind: "content", retryable: false, reconnect: false };
}

/** Delay before retry n (1-based): 30 s, 2 min, 8 min, 30 min — then give up. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 480_000, 1_800_000] as const;
export const MAX_PUBLISH_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
