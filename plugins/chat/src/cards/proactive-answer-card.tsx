/** @jsxImportSource chat */
import { Card, CardText, Section, Actions, Button } from "chat";
import type { CardElement } from "chat";
import { toCardElement } from "chat/jsx-runtime";

// ---------------------------------------------------------------------------
// Action IDs
// ---------------------------------------------------------------------------

/** Action ID for the "Yes, answer" button on a proactive-offer card. */
export const PROACTIVE_ANSWER_ACTION_ID = "atlas_proactive_answer";

/** Action ID for the "Not now" dismissal button. */
export const PROACTIVE_DISMISS_ACTION_ID = "atlas_proactive_dismiss";

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
 * Slice #2293 keeps this minimal — markdown body + a fallback string.
 * Rich result cards (charts, exports) come from the existing
 * `buildQueryResultCard` once the full agent loop wires through; for
 * now we use a plain text card so the proactive path can ship.
 */
export function buildProactiveAnswerCard(answer: string): {
  card: CardElement;
  fallbackText: string;
} {
  const trimmed = answer.trim().length > 0 ? answer : "(no answer produced)";
  const jsx = (
    <Card>
      <Section>
        <CardText>{trimmed}</CardText>
      </Section>
    </Card>
  );
  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build proactive answer card");
  }
  return { card, fallbackText: trimmed };
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
