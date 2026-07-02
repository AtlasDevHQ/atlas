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
const { describeArchive } = await import("../page");

function collection(partial: Partial<KnowledgeCollection> = {}): KnowledgeCollection {
  return {
    slug: "runbooks",
    description: "On-call runbooks",
    installedAt: "2026-07-02T00:00:00.000Z",
    documents: { draft: 2, published: 3, archived: 0 },
    ...partial,
  };
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
});
