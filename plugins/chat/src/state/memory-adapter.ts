/**
 * In-memory state adapter for development and testing.
 *
 * Thin re-export of Chat SDK's built-in memory state adapter.
 * State is lost on restart — use the PG adapter for production.
 */

export { createMemoryState } from "@chat-adapter/state-memory";
