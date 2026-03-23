/** @jsxImportSource chat */
import { Card, CardText, Section, Actions, Button } from "chat";
import type { CardElement } from "chat";
import { toCardElement } from "chat/jsx-runtime";
import type { PendingAction } from "../config";

/**
 * Build an approval card with approve/deny buttons.
 * Returns { card, fallbackText } for cross-platform compatibility.
 */
export function buildApprovalCardJSX(action: PendingAction): {
  card: CardElement;
  fallbackText: string;
} {
  const summary = (action.summary || action.type).slice(0, 200);

  const jsx = (
    <Card title="Action requires approval">
      <Section>
        <CardText>{summary}</CardText>
      </Section>
      <Actions>
        <Button id="atlas_action_approve" style="primary" value={action.id}>
          Approve
        </Button>
        <Button id="atlas_action_deny" style="danger" value={action.id}>
          Deny
        </Button>
      </Actions>
    </Card>
  );

  const card = toCardElement(jsx)!;

  const fallbackText = `Action requires approval: ${summary}`;

  return { card, fallbackText };
}
