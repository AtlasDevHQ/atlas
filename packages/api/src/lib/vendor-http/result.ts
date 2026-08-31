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
 * verdict the vendor actually returned. The action clients rendered that
 * distinction as separately-worded throws per vendor — three verbatim copies
 * of the abort classification alone. They still throw (their public contract
 * is unchanged); what they no longer each own is the classification.
 *
 * ⚠️ **No consumer switches on `reason` today, and that is worth knowing
 * before you build on it.** Each producer emits exactly one variant —
 * `withVendorDeadline` only ever a `timeout`, `describeHttpFailure` only ever
 * an `http` — and each call site throws at the seam rather than passing a
 * failure onward, so what the migrated clients actually read is `.ok`,
 * `.value`, `.cause`, `.status` and `.detail`. The discriminant earns its
 * place when a caller holds BOTH, which is the ADR-0045 `{ ok } | ReadError`
 * shape the deferred connector adoption needs. Until one does, `F` below is
 * what makes the union pay for itself.
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
 * timeout — `linear.ts` is the live case. It defaults to the full union,
 * which is what a consumer holding both variants would take; nothing does
 * yet.
 */
export type VendorHttpResult<T, F extends VendorFailure = VendorFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: F };
