import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { useState } from "react";
import { render, cleanup, screen } from "@testing-library/react";
import type { KnowledgeCollection, KnowledgeCollectionListResponse } from "@/ui/lib/types";

// --- Mocks (declared before importing the page so it binds to them) --------

let fetchState: {
  data: KnowledgeCollectionListResponse | null;
  loading: boolean;
  error: unknown;
} = { data: null, loading: false, error: null };

mock.module("nuqs", () => ({
  parseAsString: {},
  useQueryStates: () => useState<{ collection: string | null }>({ collection: null }),
}));

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ ...fetchState, setError: () => {}, refetch: () => {} }),
  useInProgressSet: () => ({ has: () => false, start: () => {}, stop: () => {} }),
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async () => ({ ok: true, data: {} }),
    saving: false,
    error: null,
    reset: () => {},
  }),
}));

mock.module("@/lib/api-url", () => ({ getApiUrl: () => "" }));

const KnowledgePage = (await import("../page")).default;
const { describeArchive, describeSync } = await import("../page");

function collection(partial: Partial<KnowledgeCollection> = {}): KnowledgeCollection {
  return {
    slug: "runbooks",
    source: "upload",
    description: "On-call runbooks",
    installedAt: "2026-07-02T00:00:00.000Z",
    endpointUrl: null,
    sync: null,
    documents: { draft: 2, published: 3, archived: 0 },
    ...partial,
  };
}

function syncedCollection(partial: Partial<KnowledgeCollection> = {}): KnowledgeCollection {
  return collection({
    slug: "synced-docs",
    source: "bundle-sync",
    endpointUrl: "https://kb.example.com/bundle.tar.gz",
    sync: { lastSyncAt: "2026-07-02T01:00:00.000Z", status: "success", error: null },
    ...partial,
  });
}

function connectorCollection(partial: Partial<KnowledgeCollection> = {}): KnowledgeCollection {
  return collection({
    slug: "confluence-eng",
    source: "confluence",
    // Connectors carry no bundle endpoint / auth scheme.
    endpointUrl: null,
    authScheme: null,
    sync: { lastSyncAt: "2026-07-02T02:00:00.000Z", status: "success", error: null },
    ...partial,
  });
}

describe("describeArchive", () => {
  test("surfaces the active document breakdown", () => {
    expect(describeArchive(collection())).toBe(
      "This will archive 5 documents (3 published, 2 draft).",
    );
  });

  test("handles a single published document", () => {
    expect(
      describeArchive(collection({ documents: { draft: 0, published: 1, archived: 0 } })),
    ).toBe("This will archive 1 document (1 published).");
  });

  test("handles an empty collection", () => {
    expect(
      describeArchive(collection({ documents: { draft: 0, published: 0, archived: 4 } })),
    ).toBe("This collection has no active documents.");
  });
});

describe("KnowledgePage", () => {
  beforeEach(() => {
    fetchState = { data: null, loading: false, error: null };
  });
  afterEach(() => cleanup());

  test("renders a card per collection with status counts", () => {
    fetchState = {
      data: { collections: [collection(), collection({ slug: "policies" })] },
      loading: false,
      error: null,
    };
    render(<KnowledgePage />);
    expect(screen.getByText("runbooks")).toBeDefined();
    expect(screen.getByText("policies")).toBeDefined();
    // Both cards show their published/draft badges.
    expect(screen.getAllByText("3 published").length).toBe(2);
    expect(screen.getAllByText("2 draft").length).toBe(2);
  });

  test("renders the empty state when there are no collections", () => {
    fetchState = { data: { collections: [] }, loading: false, error: null };
    render(<KnowledgePage />);
    expect(screen.getByText("No collections yet")).toBeDefined();
  });

  test("a bundle-sync collection shows Sync now (not Upload), its endpoint, and the synced badge (#4211)", () => {
    fetchState = { data: { collections: [syncedCollection()] }, loading: false, error: null };
    render(<KnowledgePage />);
    expect(screen.getByTestId("sync-synced-docs")).toBeDefined();
    expect(screen.queryByTestId("upload-synced-docs")).toBeNull();
    expect(screen.getByText("https://kb.example.com/bundle.tar.gz")).toBeDefined();
    expect(screen.getByText("synced")).toBeDefined();
  });

  test("a failed last sync surfaces the error state on the card", () => {
    fetchState = {
      data: {
        collections: [
          syncedCollection({
            sync: {
              lastSyncAt: "2026-07-02T01:00:00.000Z",
              status: "error",
              error: 'Bundle endpoint "kb.example.com" responded HTTP 403',
            },
          }),
        ],
      },
      loading: false,
      error: null,
    };
    render(<KnowledgePage />);
    expect(screen.getByText(/Sync failed/)).toBeDefined();
  });

  test("an upload collection keeps the Upload action and shows no sync affordance", () => {
    fetchState = { data: { collections: [collection()] }, loading: false, error: null };
    render(<KnowledgePage />);
    expect(screen.getByTestId("upload-runbooks")).toBeDefined();
    expect(screen.queryByTestId("sync-runbooks")).toBeNull();
  });

  test("a connector collection shows Sync now + synced badge, but no endpoint-edit dialog (#4377)", () => {
    fetchState = {
      data: {
        collections: [
          connectorCollection({
            sync: { lastSyncAt: "2026-07-02T02:00:00.000Z", status: "success", error: null },
          }),
        ],
      },
      loading: false,
      error: null,
    };
    render(<KnowledgePage />);
    expect(screen.getByTestId("sync-confluence-eng")).toBeDefined();
    expect(screen.queryByTestId("upload-confluence-eng")).toBeNull();
    // Connectors are re-configured via their integration install, not the
    // bundle-sync endpoint dialog.
    expect(screen.queryByTestId("edit-confluence-eng")).toBeNull();
    expect(screen.getByText("synced")).toBeDefined();
  });
});

describe("describeSync", () => {
  test("null for upload collections", () => {
    expect(describeSync(collection())).toBeNull();
  });
  test("never-synced before the first attempt", () => {
    expect(describeSync(syncedCollection({ sync: null }))).toBe("never-synced");
  });
  test("tracks the last attempt's outcome", () => {
    expect(describeSync(syncedCollection())).toBe("synced");
    expect(
      describeSync(
        syncedCollection({
          sync: { lastSyncAt: "2026-07-02T01:00:00.000Z", status: "error", error: "boom" },
        }),
      ),
    ).toBe("sync-failed");
  });
  test("classifies connector collections too (#4377)", () => {
    expect(describeSync(connectorCollection())).toBe("synced");
    expect(describeSync(connectorCollection({ sync: null }))).toBe("never-synced");
  });
});
