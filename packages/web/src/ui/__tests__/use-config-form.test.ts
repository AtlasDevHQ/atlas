import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";
import { useConfigForm } from "../hooks/use-config-form";
import { AtlasProvider } from "../context";

/* ------------------------------------------------------------------ */
/*  Setup (mirrors use-admin-mutation.test.ts)                         */
/* ------------------------------------------------------------------ */

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      { config: { apiUrl: "http://localhost:3001", isCrossOrigin: false as const, authClient: stubAuthClient } },
      children,
    ),
  );
}

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Route-aware fetch mock: GETs serve from a mutable `serverConfig`,
 * writes are recorded and answered with 200. Lets tests drive the full
 * load → edit → save → invalidate → refetch → re-baseline loop.
 */
let serverConfig: Record<string, unknown>;
let recordedWrites: { url: string; method: string; body: unknown }[];

function installRouteMock(opts?: { getStatus?: number; saveStatus?: number; saveBody?: unknown }) {
  recordedWrites = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (opts?.getStatus && opts.getStatus >= 400) {
        return jsonResponse({ error: "load failed" }, opts.getStatus);
      }
      return jsonResponse(serverConfig);
    }
    recordedWrites.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (opts?.saveStatus && opts.saveStatus >= 400) {
      return jsonResponse({ error: "save failed" }, opts.saveStatus);
    }
    return jsonResponse(opts?.saveBody ?? { ok: true });
  }) as unknown as typeof fetch;
}

const ConfigSchema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  cap: z.number().int().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});
type Config = z.infer<typeof ConfigSchema>;

interface FormValues extends Record<string, unknown> {
  enabled: boolean;
  name: string;
  cap: string;
  tags: string[];
}

function renderConfigForm() {
  return renderHook(
    () =>
      useConfigForm<Config, FormValues>({
        path: "/api/v1/admin/test-config",
        schema: ConfigSchema,
        toForm: (d) => ({
          enabled: d.enabled,
          name: d.name,
          cap: d.cap === null ? "" : String(d.cap),
          tags: d.tags,
        }),
        toPayload: (v) => ({
          enabled: v.enabled,
          name: v.name.trim(),
          cap: v.cap.trim() === "" ? null : Number(v.cap),
          tags: v.tags,
        }),
      }),
    { wrapper },
  );
}

describe("useConfigForm", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    serverConfig = {
      enabled: false,
      name: "alpha",
      cap: null,
      tags: ["a"],
      updatedAt: "2026-06-01T00:00:00Z",
    };
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  /* ---------------------------------------------------------------- */
  /*  Load → fields                                                    */
  /* ---------------------------------------------------------------- */

  test("derives fields from toForm(data) after load", async () => {
    installRouteMock();
    const { result } = renderConfigForm();

    expect(result.current.fields).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.fields).not.toBeNull());

    expect(result.current.loading).toBe(false);
    expect(result.current.fields!.enabled.value).toBe(false);
    expect(result.current.fields!.name.value).toBe("alpha");
    expect(result.current.fields!.cap.value).toBe("");
    expect(result.current.fields!.tags.value).toEqual(["a"]);
    expect(result.current.dirty).toBe(false);
  });

  test("surfaces load failures via loadError, fields stay null", async () => {
    installRouteMock({ getStatus: 500 });
    const { result } = renderConfigForm();

    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    expect(result.current.fields).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  Dirty compare                                                    */
  /* ---------------------------------------------------------------- */

  test("dirty flips on edit and back on revert — single canonical compare", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    act(() => result.current.fields!.name.set("beta"));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.fields!.name.set("alpha"));
    expect(result.current.dirty).toBe(false);
  });

  test("dirty compare is deep — array fields participate without page wiring", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    // New array with equal contents — NOT dirty (deep compare, not identity).
    act(() => result.current.fields!.tags.set(["a"]));
    expect(result.current.dirty).toBe(false);

    act(() => result.current.fields!.tags.set(["a", "b"]));
    expect(result.current.dirty).toBe(true);
  });

  test("reset restores the server-derived baseline", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    act(() => {
      result.current.fields!.enabled.set(true);
      result.current.fields!.cap.set("42");
    });
    expect(result.current.dirty).toBe(true);

    act(() => result.current.reset());
    expect(result.current.dirty).toBe(false);
    expect(result.current.fields!.enabled.value).toBe(false);
    expect(result.current.fields!.cap.value).toBe("");
  });

  /* ---------------------------------------------------------------- */
  /*  Save                                                             */
  /* ---------------------------------------------------------------- */

  test("save posts toPayload(values) to the path with the configured method", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    act(() => {
      result.current.fields!.enabled.set(true);
      result.current.fields!.cap.set(" 10 ");
    });

    // Refetch after save returns the new server truth.
    serverConfig = { ...serverConfig, enabled: true, cap: 10, updatedAt: "2026-06-02T00:00:00Z" };

    await act(async () => {
      const res = await result.current.save();
      expect(res.ok).toBe(true);
    });

    expect(recordedWrites).toHaveLength(1);
    expect(recordedWrites[0]!.method).toBe("PUT");
    expect(recordedWrites[0]!.url).toBe("http://localhost:3001/api/v1/admin/test-config");
    expect(recordedWrites[0]!.body).toEqual({
      enabled: true,
      name: "alpha",
      cap: 10,
      tags: ["a"],
    });

    // Post-save invalidation refetches and re-baselines: dirty returns false.
    await waitFor(() => expect(result.current.dirty).toBe(false));
    expect(result.current.fields!.cap.value).toBe("10");
  });

  test("save failure populates error and keeps edits + dirty", async () => {
    installRouteMock({ saveStatus: 500 });
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    act(() => result.current.fields!.name.set("gamma"));

    await act(async () => {
      const res = await result.current.save();
      expect(res.ok).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.fields!.name.value).toBe("gamma");
    expect(result.current.dirty).toBe(true);

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  test("save before load resolves { ok: false } without a request", async () => {
    installRouteMock({ getStatus: 500 });
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.loadError).not.toBeNull());

    await act(async () => {
      const res = await result.current.save();
      expect(res.ok).toBe(false);
    });
    expect(recordedWrites).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Re-baseline semantics                                            */
  /* ---------------------------------------------------------------- */

  test("refetch with changed server data re-baselines the form", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    serverConfig = { ...serverConfig, name: "renamed", updatedAt: "2026-06-03T00:00:00Z" };
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.fields!.name.value).toBe("renamed"));
    expect(result.current.dirty).toBe(false);
  });

  test("refetch with identical server data does not clobber in-flight edits", async () => {
    installRouteMock();
    const { result } = renderConfigForm();
    await waitFor(() => expect(result.current.fields).not.toBeNull());

    act(() => result.current.fields!.name.set("editing..."));

    // Same JSON content — TanStack structural sharing keeps the same data
    // reference, so the hook must not re-baseline.
    await act(async () => {
      result.current.refetch();
    });

    expect(result.current.fields!.name.value).toBe("editing...");
    expect(result.current.dirty).toBe(true);
  });
});
