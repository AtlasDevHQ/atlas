/**
 * Pure state transitions for the dashboard canvas's interaction polish (#4567,
 * PRD #4553 L3–L4). The page's handlers are thin wrappers over these so the
 * actual regression surfaces — per-tile refresh tracking and IDENTITY-keyed
 * suggestion accept/dismiss — are unit-testable without mounting the page.
 */

import type { DashboardSuggestion } from "@/ui/lib/types";

// ---------------------------------------------------------------------------
// Per-tile refresh tracking (L3) — a SET, so two concurrent refreshes each
// keep their own spinner; a slower one settling never clears a faster one.
// ---------------------------------------------------------------------------

/** Add `id` to the in-flight refresh set (immutable copy-on-write). */
export function withRefreshing(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (prev.has(id)) return prev;
  const next = new Set(prev);
  next.add(id);
  return next;
}

/** Remove ONLY `id` from the in-flight refresh set — the others stay in flight. */
export function withoutRefreshing(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!prev.has(id)) return prev;
  const next = new Set(prev);
  next.delete(id);
  return next;
}

// ---------------------------------------------------------------------------
// Stable-id suggestions (L4) — accept/dismiss key on a minted identity, never
// array index, so a concurrent add/dismiss reindexing the list can't act on the
// wrong item.
// ---------------------------------------------------------------------------

/** An AI suggestion plus a client-minted stable id for identity-keyed actions. */
export type SuggestionItem = DashboardSuggestion & { clientId: string };

/**
 * Mint a stable client id. Prefers `crypto.randomUUID`, falling back to a
 * counter + random suffix when it's unavailable — `randomUUID` is absent
 * (undefined) outside a secure context, e.g. a self-hosted origin served over
 * plain HTTP, which the `typeof` guard handles; the `try/catch` is defensive
 * belt-and-suspenders against an unexpected throw. Either way, a suggestion list
 * that came back fine from the server must never fail to render over an id.
 */
let idCounter = 0;
export function makeClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // intentionally ignored: fall through to the non-crypto id below
  }
  idCounter += 1;
  return `sug-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2)}`;
}

/** Attach a stable client id to each raw suggestion (id factory injectable for tests). */
export function attachSuggestionIds(
  raw: readonly DashboardSuggestion[],
  idFactory: () => string = makeClientId,
): SuggestionItem[] {
  return raw.map((s) => ({ ...s, clientId: idFactory() }));
}

/** Drop the suggestion with `clientId` — identity match, never a positional index. */
export function dropSuggestion(list: readonly SuggestionItem[], clientId: string): SuggestionItem[] {
  return list.filter((s) => s.clientId !== clientId);
}
