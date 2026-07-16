import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import type { Dashboard } from "@/ui/lib/types";

/**
 * Shared test fixtures for the dashboards surface tests (switcher, view-all
 * modal, redirect index, new-dashboard dialog). They all hit the same
 * `/api/v1/dashboards` endpoint and need the same Atlas + Query providers —
 * keeping the stub auth client, wrapper, and fetch stubbers here avoids drift
 * between the suites.
 */

export const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

export function dashboardsWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <AtlasProvider
        config={{
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        }}
      >
        {children}
      </AtlasProvider>
    </QueryClientProvider>
  );
}

export interface DashboardRow {
  id: string;
  title: string;
  updatedAt: string;
  cardCount: number;
}

/** Build a full Dashboard wire-shape stub from a minimal row. Typed as the
 *  wire type so a `Dashboard` field addition is a compile error here instead
 *  of silent fixture drift. */
export function buildDashboardWireRow(r: DashboardRow): Dashboard {
  return {
    id: r.id,
    title: r.title,
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    // Unshared on the wire = null token + the "public" default the API emits
    // (`share_mode ?? "public"` in lib/dashboards.ts) — "private" is not a
    // ShareMode; typing this fixture as Dashboard is what caught that drift.
    shareMode: "public",
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    parameters: [],
    cardCount: r.cardCount,
    createdAt: r.updatedAt,
    updatedAt: r.updatedAt,
    orgId: null,
    ownerId: "u",
  };
}

/**
 * Replace `globalThis.fetch` with a stub that responds to
 * `GET /api/v1/dashboards` with the given rows. Throws on any other URL so
 * unexpected calls surface loudly. Caller is responsible for restoring the
 * original fetch in `afterEach`.
 */
export function stubDashboardsFetch(rows: DashboardRow[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.endsWith("/api/v1/dashboards")) {
      return new Response(
        JSON.stringify({
          dashboards: rows.map(buildDashboardWireRow),
          total: rows.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/**
 * Like {@link stubDashboardsFetch}, but also answers `POST /api/v1/dashboards`
 * with the given `created` row — for the surface-native creation-navigation
 * tests (#4563). Faithful to the real API: once the POST has fired, subsequent
 * GETs include the created row (this is what makes the redirect-index page's
 * post-creation refetch → `router.replace` race reproducible in tests).
 * Returns the list of parsed POST bodies received so tests can pin the create
 * payload.
 */
export function stubDashboardsFetchWithCreate(
  rows: DashboardRow[],
  created: DashboardRow,
): unknown[] {
  const createBodies: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/api/v1/dashboards") && method === "POST") {
      createBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify(buildDashboardWireRow(created)), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/v1/dashboards")) {
      const visible = createBodies.length > 0 ? [...rows, created] : rows;
      return new Response(
        JSON.stringify({
          dashboards: visible.map(buildDashboardWireRow),
          total: visible.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return createBodies;
}
