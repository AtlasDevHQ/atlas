/**
 * Durable session-memory wire types (#3758, ADR-0020).
 *
 * The read/reset affordance over a session's accumulated durable working memory
 * (`agent_session_memory`, migration 0145). One slot is a named JSONB value the
 * agent stashed in a prior turn ("the user means EU revenue"); a session view
 * bundles a conversation with the slots it has accumulated. Shared across the API
 * responses, the admin Session Memory page, and the in-conversation reset
 * control.
 */

/** One persisted durable-working-memory slot for a session. */
export interface SessionMemorySlot {
  /** Slot name, e.g. `"analyst.lastTable"`. */
  namespace: string;
  /** The remembered value — any JSON-serializable payload (round-trips through JSONB). */
  value: unknown;
  /** ISO-8601 timestamp of the slot's last write. */
  updatedAt: string;
}

/** A session (conversation) and the durable working-memory slots it has accumulated. */
export interface SessionMemoryView {
  /** The conversation (session) the slots belong to. */
  conversationId: string;
  /** The conversation's title, or `null` if untitled. */
  title: string | null;
  /** ISO-8601 timestamp of the most recently written slot in the session. */
  updatedAt: string;
  /** Every named slot the session has accumulated, ordered by name. */
  slots: SessionMemorySlot[];
}
