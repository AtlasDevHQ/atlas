"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Which docs section a page is being rendered in. Injected at the route
 * boundary (SaaS root vs `/self-hosted`) so a single shared MDX file can adapt
 * to its mount — the reader only ever sees their audience's branch, resolved at
 * build time rather than as a reader-facing tab (PRD #4257).
 */
export type Audience = "saas" | "self-hosted";

const AudienceContext = createContext<Audience>("saas");

/**
 * Wrap a section's MDX render in the audience it belongs to. Each human route
 * group renders exactly one static value ("saas" at the root, "self-hosted"
 * under `/self-hosted`).
 */
export function AudienceProvider({
  audience,
  children,
}: {
  audience: Audience;
  children: ReactNode;
}) {
  return (
    <AudienceContext.Provider value={audience}>
      {children}
    </AudienceContext.Provider>
  );
}

/** Read the current route's audience from any component inside the MDX scope. */
export function useAudience(): Audience {
  return useContext(AudienceContext);
}

/**
 * MDX component that renders the current route's audience. Exposed to MDX so a
 * shared page can prove the route-injected value: the same `content/shared/…`
 * file renders `saas` at the root and `self-hosted` under `/self-hosted`. The
 * `data-audience` attribute makes the injected value observable in the static
 * HTML export (and assertable in a render test) without depending on visible
 * copy.
 */
export function AudienceLabel() {
  const audience = useAudience();
  return <span data-audience={audience}>{audience}</span>;
}
