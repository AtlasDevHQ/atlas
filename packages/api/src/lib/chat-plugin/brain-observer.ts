/**
 * Host wiring for the chat plugin's per-message observer (#4967, ADR-0036 §T6)
 * — the seam between "a chat message arrived" and "store it as a brain episode
 * now rather than at the next sync tick".
 *
 * It lives here, next to `executeQuery.ts`, rather than under `lib/brain/`, for
 * the same reason that one does: this is the layer that speaks BOTH the plugin
 * boundary's vocabulary (`ChatMessageObservation`, `platform: "slack"`) and the
 * brain's (`ingestSlackWebhookMessage`). `lib/brain/ingest/slack/webhook.ts`
 * takes a raw Slack payload and knows nothing about `@useatlas/chat`; keeping
 * that true is what lets the episode writer be tested with a plain object and
 * no plugin in scope.
 *
 * ## Why the platform switch is a REFUSAL and not a fallthrough
 *
 * Every chat adapter Atlas wires (Teams, Discord, gchat, …) delivers messages
 * through this same observer, and only Slack has a brain source today. A
 * default arm that tried to store them would mint episodes under a source-id
 * grammar no connector owns; a default arm that silently ignored them is
 * correct but must be VISIBLE, because the day a second chat vendor gets a
 * brain source, "it is wired and quietly doing nothing" is the failure that
 * looks like success. So the unknown-platform arm is counted and debug-logged,
 * and `sources.ts`'s vendor axis is where the second vendor gets added.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ChatMessageObservation, ObserveMessageFn } from "@useatlas/chat";
import { SLACK_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  ingestSlackWebhookMessage,
  type SlackWebhookIngestOutcome,
  type SlackWebhookSkipReason,
} from "@atlas/api/lib/brain/ingest/slack/webhook";

const log = createLogger("chat-plugin.brain-observer");

/**
 * Skip reasons where there was genuinely nothing to store, so nothing was lost.
 *
 * They are steady-state for any deployment running Atlas chat without a
 * Slack-history source, or with one scoped to a subset of channels — which is
 * the normal case, not a fault. They must not reach the `pollBackstopped: false`
 * warn arm in {@link reportNotStored}: that arm says "this evidence is LOST",
 * and for a thread reply in a channel the admin deliberately never scoped,
 * nothing was lost — there was nothing to store. Left as a warn it fires once
 * per thread reply, forever, on a correct configuration: the exact shape of
 * alert that trains an operator to ignore the channel that also carries the
 * real one.
 *
 * `unmintable_subtype` is here for a different reason than the other two. The
 * others were never in scope; a `message_deleted` or `tombstone` IS in a scoped
 * channel, but a deletion carries no content to lose. It never reaches the warn
 * arm on its own — `webhook.ts` reports the whole pre-parse read-skip class as
 * `pollBackstopped: true` — so this is about the MESSAGE, not the level: the
 * default debug arm would tell an operator "the scheduled sync still covers it",
 * and there is nothing for the sync to cover.
 *
 * ⚠️ `unknown_workspace` is deliberately NOT here, and it is the member a reader
 * expects to find. See its own arm in {@link reportNotStored}.
 *
 * Typed against the union rather than left as bare strings: a renamed reason
 * must break the BUILD, not silently stop matching and quietly restore the
 * warn-spam this exists to prevent.
 */
const NOTHING_TO_STORE: ReadonlySet<SlackWebhookSkipReason> = new Set<SlackWebhookSkipReason>([
  "no_install",
  "channel_not_configured",
  "unmintable_subtype",
]);

/**
 * Build the observer the chat plugin calls for every inbound message.
 *
 * NEVER throws and never rejects — the plugin's contract
 * (`ObserveMessageFn`) requires it, and the bridge's own wrapper is a backstop
 * rather than a licence to leak. The writer it delegates to already converts
 * every failure into an outcome; this function adds no failure mode of its own.
 *
 * Returns `Promise<void>`: the bridge ignores results, and there is deliberately
 * nothing an observation can tell the chat pillar. The outcome is surfaced to
 * TESTS through the injectable `ingest` dep instead of through a return value,
 * so the seam cannot grow a channel back into chat behaviour by accident.
 */
export function createBrainChatMessageObserver(deps?: {
  /** Test-only injection; defaults to the real Slack webhook writer. */
  readonly ingest?: (raw: unknown) => Promise<SlackWebhookIngestOutcome>;
  /**
   * Test-only sink for the not-stored report. Injected rather than mocked
   * because the LEVEL is the assertion: a lost thread reply must warn and a
   * deferred top-level message must not, and a test that could not see the
   * level would certify the misleading version.
   */
  readonly report?: (level: "warn" | "debug", detail: Record<string, unknown>) => void;
}): ObserveMessageFn {
  const ingest = deps?.ingest ?? ((raw: unknown) => ingestSlackWebhookMessage({ raw }));
  const report = deps?.report;
  return async (observation: ChatMessageObservation): Promise<void> => {
    if (observation.platform !== SLACK_SOURCE) {
      log.debug(
        { platform: observation.platform },
        "Chat brain observer: no brain source for this platform — nothing stored (the platform has no episode-source vendor yet)",
      );
      return;
    }
    const outcome = await ingest(observation.message.raw);
    switch (outcome.status) {
      case "inserted":
      case "duplicate":
        // Stored (by us, or already by the poll). `webhook.ts` debug-logs the
        // insert; a second line here would double every message's log volume
        // for no added fact.
        return;
      case "skipped":
      case "refused":
        reportNotStored(outcome, observation, report);
        return;
      default: {
        // Exhaustiveness, enforced by the compiler rather than by review. A new
        // outcome arm must be handled here or this fails to build — the
        // alternative is a `if (status === "skipped")` that silently ignores it,
        // which is how a fault arm ends up invisible.
        const unreachable: never = outcome;
        log.warn(
          { outcome: unreachable },
          "Chat brain observer: unhandled episode-writer outcome — this is a code defect, not a data condition",
        );
        return;
      }
    }
  };
}

/**
 * Log a message the fast path did not store, at a level that reflects whether
 * anything else will.
 *
 * The distinction is the whole point. "The scheduled sync still covers it" is
 * true for a top-level message and FALSE for a thread reply — the poll calls
 * only `conversations.history`, which never returns replies. A single reassuring
 * debug line for both would be worse than silence: it would assert a backstop
 * that does not exist, on the exact class of message this path uniquely covers.
 */
function reportNotStored(
  outcome: Extract<SlackWebhookIngestOutcome, { status: "skipped" | "refused" }>,
  observation: ChatMessageObservation,
  report?: (level: "warn" | "debug", detail: Record<string, unknown>) => void,
): void {
  // `disabled` is the steady state while the knob is off. It is the one arm
  // that must not emit per-message — at Slack volume it would be the noisiest
  // line in the process, and it reports the operator's own configuration back
  // to them.
  if (outcome.status === "skipped" && outcome.reason === "disabled") return;

  // See {@link NOTHING_TO_STORE} for why these must not reach the warn arm.
  if (outcome.status === "skipped" && NOTHING_TO_STORE.has(outcome.reason)) {
    const detail = { reason: outcome.reason, messageId: observation.message.id };
    report?.("debug", detail);
    log.debug(
      detail,
      "Chat brain observer: message carries no evidence to store — either outside this deployment's brain scope, or a subtype with no content. Nothing was lost",
    );
    return;
  }

  // `unknown_workspace` is TWO populations wearing one reason code, and the
  // observer cannot tell them apart from here.
  //
  // The benign one: the Slack team has no Atlas workspace mapped — steady state
  // for any deployment running Atlas chat without slack-history, so warning
  // would be the same per-reply forever spam the arm above exists to prevent.
  //
  // The other one: `webhook.ts` documents that the installation store's
  // decrypt-or-hide-row policy hides the WHOLE row when the bot token will not
  // decrypt, so a rotated envelope key on a deployment that DOES run
  // slack-history reads here as `unknown_workspace` too. In that state a thread
  // reply genuinely is lost — `conversations.history` never returns replies, and
  // the poll needs the same token this path could not decrypt, so it is not a
  // backstop. Telling an operator "nothing was lost" there would be false in the
  // one function whose whole job is getting that distinction right.
  //
  // So: the benign case's level, without the benign case's claim. Separating
  // them for real means teaching the store to distinguish absent from
  // undecryptable — a credential-path change, deliberately not made here.
  if (outcome.status === "skipped" && outcome.reason === "unknown_workspace") {
    const detail = { reason: outcome.reason, messageId: observation.message.id };
    report?.("debug", detail);
    log.debug(
      detail,
      "Chat brain observer: no Atlas workspace is mapped to this Slack team, so nothing was stored. Usually means the brain is not configured for this team — but an install whose bot token will not decrypt is hidden by the same policy and reads identically here, and in THAT case a thread reply is lost rather than delayed",
    );
    return;
  }

  const detail = {
    reason: outcome.status === "skipped" ? outcome.reason : "ingest_refused",
    messageId: observation.message.id,
  };
  if (!outcome.pollBackstopped) {
    report?.("warn", detail);
    log.warn(
      detail,
      "Chat brain observer: a message with NO poll backstop was not stored — thread replies are never returned by conversations.history, so this evidence is lost rather than delayed",
    );
    return;
  }
  report?.("debug", detail);
  log.debug(
    detail,
    "Chat brain observer: message not stored by the fast path — the scheduled sync still covers it",
  );
}
