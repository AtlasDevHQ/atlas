/**
 * Concrete email-outbox dispatcher (#2942).
 *
 * Bridges the generic queue (`outbox.ts`) to the email delivery layer.
 * The send function is INJECTED (`makeEmailDispatcher(sendEmail)`) so
 * the queue mechanics stay decoupled from `email/delivery.ts` and the
 * unit test can drive it with a fake — and, importantly, so the flusher
 * re-send path calls the RAW `sendEmail` (no `sendTransactionalEmail`
 * wrapper), which means a re-send failure does NOT re-enqueue and
 * create an unbounded duplication loop.
 *
 * Classification: `sendEmail` returns a `DeliveryResult` without an HTTP
 * status, and the in-process `fetchWithRetry` (PR #2949) already
 * exhausted transient retries before a row was ever enqueued. So every
 * flusher-time failure is classified `transient` and rides the backoff
 * schedule to wait out a SUSTAINED outage. A genuinely permanent
 * failure (bad API key, malformed payload) still terminates — it
 * dead-letters once the retry budget is exhausted, with the provider's
 * error message preserved on the row for triage. We deliberately do NOT
 * thread the HTTP status through `DeliveryResult` to distinguish
 * permanent-vs-transient here: it would ripple through every delivery
 * call site for a marginal latency win on a rare misconfiguration, and
 * the retry budget already bounds the cost.
 */

import type { DeliveryResult, EmailMessage } from "@atlas/api/lib/email/delivery";
import type {
  ClaimedEmailRow,
  EmailDispatcher,
  EmailDispatchOutcome,
  EmailOutboxMessage,
} from "./outbox";

/**
 * Compile-time lockstep guard: `EmailOutboxMessage` (the locally-defined
 * row payload shape, kept decoupled from the delivery layer) must carry
 * every field `EmailMessage` does. If someone adds a field to
 * `EmailMessage` (e.g. `cc`, `replyTo`, `text`) without also adding it to
 * `EmailOutboxMessage` + `coerceMessage`, the outbox would silently drop
 * it on the enqueue→re-send round-trip. This turns that silent field-drop
 * into a red build. (`Exclude<...> extends never` is `true` only when
 * EmailOutboxMessage's keys are a superset of EmailMessage's.)
 */
type _EmailOutboxMessageCoversEmailMessage =
  Exclude<keyof EmailMessage, keyof EmailOutboxMessage> extends never ? true : never;
const _emailOutboxMessageLockstep: _EmailOutboxMessageCoversEmailMessage = true;

/**
 * Shape of `email/delivery.ts:sendEmail`. Declared structurally so
 * `dispatch.ts` has only a type-level dependency on the delivery layer
 * (no runtime import) — keeps the unit test light and the module graph
 * acyclic.
 */
export type EmailSendFn = (message: EmailMessage, orgId?: string) => Promise<DeliveryResult>;

export function makeEmailDispatcher(send: EmailSendFn): EmailDispatcher {
  return async (row: ClaimedEmailRow): Promise<EmailDispatchOutcome> => {
    const result = await send(
      { to: row.message.to, subject: row.message.subject, html: row.message.html },
      // `orgId` is nullable on the row but `sendEmail` expects
      // `string | undefined` — normalize so the DB-config lookup path
      // is taken only when an org actually scopes the send.
      row.orgId ?? undefined,
    );
    if (result.success) return { kind: "ok" };
    return {
      kind: "transient",
      message: result.error ?? `email delivery failed via ${result.provider}`,
    };
  };
}
