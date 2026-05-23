/** @jsxImportSource chat */
import { Card, CardText, Section, Actions, Button, Modal, TextInput } from "chat";
import type { CardElement, ModalElement } from "chat";
import { toCardElement, toModalElement } from "chat/jsx-runtime";
import {
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_INPUT_ID,
  PROACTIVE_FB_WRONG_DATA_MODAL_ID,
} from "../proactive/feedback";

// ---------------------------------------------------------------------------
// Action IDs
// ---------------------------------------------------------------------------

/** Action ID for the "Yes, answer" button on a proactive-offer card. */
export const PROACTIVE_ANSWER_ACTION_ID = "atlas_proactive_answer";

/** Action ID for the "Not now" dismissal button. */
export const PROACTIVE_DISMISS_ACTION_ID = "atlas_proactive_dismiss";

/**
 * Action ID for the "Show SQL" disclosure button on a conversational
 * proactive-answer card (#2705). Surfaces the analyst-grade SQL that
 * the conversational presentation mode intentionally suppressed.
 */
export const PROACTIVE_SHOW_SQL_ACTION_ID = "atlas_proactive_show_sql";

/**
 * Action ID for the "Show details" disclosure button (#2705). Surfaces
 * the developer-mode rendering (tables, breakdowns) the conversational
 * answer omitted to keep the channel post terse.
 */
export const PROACTIVE_SHOW_DETAILS_ACTION_ID = "atlas_proactive_show_details";

// ---------------------------------------------------------------------------
// Offer card
// ---------------------------------------------------------------------------

/**
 * Build the "I can answer this" offer card.
 *
 * Sent as an ephemeral message to the asker after Atlas reacts with 🤖.
 * `messageId` round-trips through the button's `value` so the action
 * handler can look up the original question without storing a separate
 * mapping per asker.
 */
export function buildProactiveOfferCard(messageId: string): {
  card: CardElement;
  fallbackText: string;
} {
  const jsx = (
    <Card title="I can answer this">
      <Section>
        <CardText>
          I think this is a data question I can answer. React 🤖 on your
          message, or use the button below — only you'll see this prompt.
        </CardText>
      </Section>
      <Actions>
        <Button id={PROACTIVE_ANSWER_ACTION_ID} style="primary" value={messageId}>
          Yes, answer
        </Button>
        <Button id={PROACTIVE_DISMISS_ACTION_ID} value={messageId}>
          Not now
        </Button>
      </Actions>
    </Card>
  );

  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build proactive offer card");
  }
  return {
    card,
    fallbackText:
      "I can answer this — react with 🤖 on your message or reply to opt in.",
  };
}

// ---------------------------------------------------------------------------
// Linked-asker answer card
// ---------------------------------------------------------------------------

/**
 * Build the in-thread answer card for a linked asker.
 *
 * Includes the slice #2298 inline feedback row when `answerId` is
 * provided. The button `value` carries `answerId` so the action
 * handler can attribute the feedback to the right Atlas answer.
 *
 * Rich result cards (charts, exports) still come from the existing
 * `buildQueryResultCard` once the full agent loop wires through; this
 * card is intentionally minimal so the proactive path can ship.
 */
export function buildProactiveAnswerCard(
  answer: string,
  answerId?: string,
  /**
   * Optional disclosure-button toggles (#2705). When the host returns
   * a conversational `answer` alongside `sql` / `developerView`, the
   * proactive listener passes these flags so the card renders the
   * "Show SQL" / "Show details" buttons. The action handlers look the
   * expanded content up by `event.messageId` — the message containing
   * the button — at click time (NOT by the button `value`, which is
   * unused for disclosure routing). Keeping the payload server-side
   * sidesteps Slack's ~2000-char button-value cap and the chicken-and-
   * egg where the card's own message id isn't known until AFTER post.
   */
  disclosures: { showSql?: boolean; showDetails?: boolean } = {},
): {
  card: CardElement;
  fallbackText: string;
} {
  const trimmed = answer.trim().length > 0 ? answer : "(no answer produced)";
  const value = answerId ?? "";
  const jsx = (
    <Card>
      <Section>
        <CardText>{trimmed}</CardText>
      </Section>
      <Actions>
        {disclosures.showSql ? (
          <Button id={PROACTIVE_SHOW_SQL_ACTION_ID} value={value}>
            Show SQL
          </Button>
        ) : null}
        {disclosures.showDetails ? (
          <Button id={PROACTIVE_SHOW_DETAILS_ACTION_ID} value={value}>
            Show details
          </Button>
        ) : null}
        <Button id={PROACTIVE_FB_HELPFUL_ACTION_ID} value={value}>
          Helpful
        </Button>
        <Button id={PROACTIVE_FB_NOT_HELPFUL_ACTION_ID} value={value}>
          Not helpful
        </Button>
        <Button id={PROACTIVE_FB_WRONG_DATA_ACTION_ID} style="danger" value={value}>
          Wrong data
        </Button>
      </Actions>
    </Card>
  );
  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build proactive answer card");
  }
  return { card, fallbackText: trimmed };
}

// ---------------------------------------------------------------------------
// "Wrong data" follow-up modal
// ---------------------------------------------------------------------------

/**
 * Build the "Tell me what was wrong" modal opened by the
 * `Wrong data` button. Returns null when the host's chat platform
 * cannot render modals; the caller should silently no-op in that
 * case (the feedback button-click is still recorded).
 */
export function buildWrongDataModal(answerId: string): ModalElement | null {
  return toModalElement(
    Modal({
      callbackId: PROACTIVE_FB_WRONG_DATA_MODAL_ID,
      title: "What was wrong?",
      submitLabel: "Submit",
      notifyOnClose: false,
      privateMetadata: answerId,
      children: [
        TextInput({
          id: PROACTIVE_FB_WRONG_DATA_INPUT_ID,
          label: "Optional context (e.g. 'figure is stale — we re-stated April yesterday')",
          multiline: true,
          placeholder: "Tell us what went wrong…",
        }),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Unlinked-asker prompt
// ---------------------------------------------------------------------------

/**
 * Build the "link Atlas to see the answer" prompt for non-OAuth askers.
 *
 * Slice #2293 stops at the prompt — actually executing against a
 * curated public dataset lands in #2297 (HITL design review). The link
 * URL is host-supplied so self-hosted and SaaS can each route to their
 * own onboarding surface.
 */
export function buildUnlinkedAskerPrompt(linkUrl?: string): {
  card: CardElement;
  fallbackText: string;
} {
  const cta = linkUrl
    ? `Link your Atlas account to see this answer: ${linkUrl}`
    : "Link your Atlas account to see this answer.";

  const jsx = (
    <Card title="Connect Atlas">
      <Section>
        <CardText>{cta}</CardText>
      </Section>
    </Card>
  );
  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build unlinked-asker prompt card");
  }
  return { card, fallbackText: cta };
}
