/**
 * Concern 1 of 4 — the discriminated result shape.
 *
 * ADR-0045's first load-bearing property is the non-throwing result contract:
 * `{ ok: true, … } | ReadError`, so the caller decides per read whether a
 * failure is fatal to a record, a collection, or a pass. This is that shape
 * with ONE author, rather than one per client.
 *
 * The failure half is discriminated by `reason` because the two kinds are not
 * interchangeable to a caller: a `timeout` means the vendor was never heard
 * from and the write may or may not have landed, while an `http` failure is a
 * verdict the vendor actually returned. The five action clients rendered that
 * distinction as separately-worded throws per vendor — three verbatim copies
 * of the abort classification alone. They still throw (their public contract
 * is unchanged); what they no longer each own is the classification.
 *
 * @see ./index.ts — the spine's scope, and what it deliberately does NOT own.
 */

/**
 * The deadline fired before the vendor answered. `cause` is the original
 * rejection, kept so a caller can attach it to the error it throws — the
 * abort's identity is the evidence that this was OUR bound and not the
 * vendor's.
 */
export interface VendorTimeoutFailure {
  readonly reason: "timeout";
  readonly timeoutMs: number;
  readonly cause: unknown;
}

/**
 * The vendor answered with a non-2xx. `detail` is already bounded by
 * {@link ../failure-detail} — a caller composing it into an agent-visible
 * message never has to remember to truncate.
 */
export interface VendorHttpFailure {
  readonly reason: "http";
  readonly status: number;
  readonly detail: string;
}

export type VendorFailure = VendorTimeoutFailure | VendorHttpFailure;

/**
 * `F` narrows the failure half to what a particular producer can actually
 * emit, so a caller of {@link ../deadline.withVendorDeadline} reads
 * `failure.cause` without first re-proving that a deadline produced a
 * timeout. It defaults to the full union for anything holding both.
 */
export type VendorHttpResult<T, F extends VendorFailure = VendorFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: F };
