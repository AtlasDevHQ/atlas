import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { z } from "zod";
import { useServerDataTable } from "../hooks/use-server-data-table";
import { AtlasProvider } from "../context";

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/audit",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

interface Item {
  id: string;
  name: string;
}

const columns: ColumnDef<Item>[] = [
  { id: "id", accessorKey: "id", header: () => "ID", cell: () => null },
  {
    id: "name",
    accessorKey: "name",
    header: () => "Name",
    cell: () => null,
    enableSorting: true,
  },
];

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

/** Compose nuqs (URL state) → react-query → AtlasProvider around the hook. */
function makeWrapper(searchParams: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      NuqsTestingAdapter,
      { searchParams },
      createElement(
        QueryClientProvider,
        { client: testQueryClient },
        createElement(
          AtlasProvider,
          {
            config: {
              apiUrl: "http://localhost:3001",
              isCrossOrigin: false as const,
              authClient: stubAuthClient,
            },
          },
          children,
        ),
      ),
    );
  };
}

/** Envelope `{ items, total }` — mirrors the real list endpoints' shape. */
function listResponse(items: Item[], total: number) {
  return new Response(JSON.stringify({ items, total }), { status: 200 });
}

// No-schema variant: `select` receives raw `unknown` and narrows it itself
// (mirrors the legacy admin pages that predate wire schemas).
const select = (r: unknown) => {
  const d = r as { items: Item[]; total: number };
  return { rows: d.items, total: d.total };
};

const buildPath = ({
  offset,
  perPage,
  sortId,
  sortDesc,
}: {
  offset: number;
  perPage: number;
  sortId?: string;
  sortDesc?: boolean;
}) =>
  `/api/list?limit=${perPage}&offset=${offset}` +
  (sortId ? `&sort=${sortId}&order=${sortDesc ? "desc" : "asc"}` : "");

const ResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
  total: z.number(),
});

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;

describe("useServerDataTable", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
    // Restore even if a test that stubbed console.warn threw before its own
    // manual restore ran.
    console.warn = originalConsoleWarn;
  });

  test("derives offset from ?page/?perPage and feeds it to buildPath", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([{ id: "a", name: "A" }], 25)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          getRowId: (row) => row.id,
          defaultPerPage: 10,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("page=2&perPage=10") },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // page 2, perPage 10 → offset (2-1)*10 = 10.
    const url = (fetchMock as unknown as ReturnType<typeof mock>).mock
      .calls[0]![0] as string;
    expect(url).toBe("http://localhost:3001/api/list?limit=10&offset=10");
  });

  test("uses defaultPerPage when ?perPage is absent", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([], 0)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 50,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("") },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const url = (fetchMock as unknown as ReturnType<typeof mock>).mock
      .calls[0]![0] as string;
    // page defaults to 1, perPage to defaultPerPage → offset 0, limit 50.
    expect(url).toBe("http://localhost:3001/api/list?limit=50&offset=0");
  });

  test("a ?perPage that differs from defaultPerPage drives offset + limit", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([{ id: "a", name: "A" }], 200)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 10,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("page=3&perPage=25") },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // The URL's perPage (25) wins over defaultPerPage (10): offset (3-1)*25 = 50.
    const url = (fetchMock as unknown as ReturnType<typeof mock>).mock
      .calls[0]![0] as string;
    expect(url).toBe("http://localhost:3001/api/list?limit=25&offset=50");
  });

  test("derives sort from ?sort and feeds sortId/sortDesc to buildPath", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([{ id: "a", name: "A" }], 1)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sortParam = encodeURIComponent(
      JSON.stringify([{ id: "name", desc: true }]),
    );
    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 10,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper(`page=1&perPage=10&sort=${sortParam}`) },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // The binding surfaces the first sort column, and buildPath threads it.
    expect(result.current.sortId).toBe("name");
    expect(result.current.sortDesc).toBe(true);
    const url = (fetchMock as unknown as ReturnType<typeof mock>).mock
      .calls[0]![0] as string;
    expect(url).toContain("sort=name&order=desc");
  });

  test("an unknown ?sort column reverts to defaultSorting", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([{ id: "a", name: "A" }], 1)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // `bogus` is not a column id → the parser drops it, falling back to the
    // provided default (name asc), so an invalid URL can't leak into the fetch.
    const sortParam = encodeURIComponent(
      JSON.stringify([{ id: "bogus", desc: true }]),
    );
    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 10,
          defaultSorting: [{ id: "name", desc: false }],
          select,
          buildPath,
        }),
      { wrapper: makeWrapper(`page=1&perPage=10&sort=${sortParam}`) },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(result.current.sortId).toBe("name");
    expect(result.current.sortDesc).toBe(false);
  });

  test("select extracts rows + total; pageCount = ceil(total / perPage)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        listResponse(
          [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
          ],
          25,
        ),
      ),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          getRowId: (row) => row.id,
          defaultPerPage: 10,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("page=1&perPage=10") },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.rows).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    expect(result.current.total).toBe(25);
    // 25 rows / 10 per page → 3 pages, mirrored on the table instance.
    expect(result.current.pageCount).toBe(3);
    expect(result.current.table.getPageCount()).toBe(3);
  });

  test("pageCount clamps to 1 when total is 0 (empty result)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(listResponse([], 0)),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 20,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("") },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.table.getPageCount()).toBe(1);
  });

  test("refetch re-runs the request", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        listResponse([{ id: String(callCount), name: `row-${callCount}` }], 1),
      );
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          getRowId: (row) => row.id,
          defaultPerPage: 10,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("page=1&perPage=10") },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.rows).toEqual([{ id: "1", name: "row-1" }]);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.rows).toEqual([{ id: "2", name: "row-2" }]);
    });
  });

  test("validates the response with the provided schema (rejects wire drift)", async () => {
    // total as a string violates the schema → useAdminFetch surfaces a
    // schema_mismatch error and clears the rows rather than rendering garbage.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ items: [{ id: "a", name: "A" }], total: "nope" }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    const { result } = renderHook(
      () =>
        useServerDataTable<Item, z.infer<typeof ResponseSchema>>({
          columns,
          defaultPerPage: 10,
          schema: ResponseSchema,
          select: (r) => ({ rows: r.items, total: r.total }),
          buildPath,
        }),
      { wrapper: makeWrapper("page=1&perPage=10") },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe("schema_mismatch");
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);

    console.warn = originalWarn;
  });

  test("enabled: false skips the fetch and reports loading=false", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(listResponse([{ id: "a", name: "A" }], 1)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () =>
        useServerDataTable<Item>({
          columns,
          defaultPerPage: 10,
          enabled: false,
          select,
          buildPath,
        }),
      { wrapper: makeWrapper("page=1&perPage=10") },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
