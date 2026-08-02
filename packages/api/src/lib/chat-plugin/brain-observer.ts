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
} from "@atlas/api/lib/brain/ingest/slack/webhook";

const log = createLogger("chat-plugin.brain-observer");

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

  // Arms that mean "this traffic was NEVER in scope for the brain", as opposed
  // to "in scope and we failed to store it". They are steady-state for any
  // deployment running Atlas chat without a Slack-history source, or with one
  // scoped to a subset of channels — which is the normal case, not a fault.
  //
  // They must not reach the `pollBackstopped: false` warn arm below. That arm
  // says "this evidence is LOST", and for a thread reply in a channel the admin
  // deliberately never scoped, nothing was lost: there was nothing to store. Left
  // as a warn it fires once per thread reply, forever, on a correct
  // configuration — the exact shape of alert that trains an operator to ignore
  // the channel that also carries the real one.
  const NEVER_IN_SCOPE = new Set(["no_install", "unknown_workspace", "channel_not_configured"]);
  if (outcome.status === "skipped" && NEVER_IN_SCOPE.has(outcome.reason)) {
    const detail = { reason: outcome.reason, messageId: observation.message.id };
    report?.("debug", detail);
    log.debug(
      detail,
      "Chat brain observer: message is outside this deployment's brain scope — nothing was lost",
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
