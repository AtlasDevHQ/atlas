/** @jsxImportSource chat */
import { Card, CardText, Divider } from "chat";
import type { CardElement } from "chat";
import { toCardElement } from "chat/jsx-runtime";

export interface ErrorCardProps {
  /** Scrubbed error message (never raw — caller must scrub first). */
  message: string;
  /** Optional retry hint shown below the error. */
  retryHint?: string;
}

const DEFAULT_RETRY_HINT =
  "This may be a transient issue — please try again in a few seconds.";

/**
 * Build an error card with scrubbed message and retry guidance.
 * Returns { card, fallbackText } for cross-platform compatibility.
 */
export function buildErrorCard(props: ErrorCardProps): {
  card: CardElement;
  fallbackText: string;
} {
  const { message, retryHint = DEFAULT_RETRY_HINT } = props;

  const jsx = (
    <Card title="Unable to complete request">
      <CardText>{message}</CardText>
      <Divider />
      <CardText style="muted">{retryHint}</CardText>
    </Card>
  );

  const card = toCardElement(jsx);
  if (!card) {
    throw new Error("Failed to build error card — toCardElement returned null");
  }

  const fallbackText = `I was unable to answer your question: ${message}. ${retryHint}`;

  return { card, fallbackText };
}
