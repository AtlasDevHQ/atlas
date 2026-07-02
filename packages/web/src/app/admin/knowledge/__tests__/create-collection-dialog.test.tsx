import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Pins the install payloads the create-collection dialog builds (#4211): the
 * upload source posts to `okf-upload`, the sync source posts to `bundle-sync`
 * with `endpoint_url` + `auth_scheme` (and no stray `auth_secret` when the
 * scheme is none) — a typo'd field key or path would otherwise 400 in
 * production with zero test failures.
 */

mock.module("@/lib/api-url", () => ({ getApiUrl: () => "" }));

const CreateCollectionDialog = (await import("../create-collection-dialog")).CreateCollectionDialog;

let fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  fetchCalls = [];
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/** Radix Tabs activate on mousedown/focus (roving focus), not plain click. */
function switchToSync() {
  const trigger = screen.getByTestId("source-bundle-sync");
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
}

function renderDialog(onCreated = mock(() => {})) {
  render(
    <CreateCollectionDialog
      open
      onOpenChange={() => {}}
      onCreated={onCreated}
      existingSlugs={["taken"]}
    />,
  );
  return onCreated;
}

describe("CreateCollectionDialog install payloads", () => {
  test("upload source posts the slug + description to the okf-upload install-form", async () => {
    const onCreated = renderDialog();
    fireEvent.change(screen.getByTestId("collection-slug"), { target: { value: "runbooks" } });
    fireEvent.click(screen.getByTestId("create-collection-submit"));

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/okf-upload/install-form");
    expect(fetchCalls[0].body).toEqual({ __install_id__: "runbooks" });
    expect(onCreated).toHaveBeenCalledWith("runbooks", "upload");
  });

  test("sync source posts endpoint_url + auth_scheme to the bundle-sync install-form (no stray secret)", async () => {
    const onCreated = renderDialog();
    switchToSync();
    fireEvent.change(screen.getByTestId("collection-slug"), { target: { value: "synced-docs" } });
    fireEvent.change(screen.getByTestId("collection-endpoint"), {
      target: { value: "https://kb.example.com/bundle.tar.gz" },
    });
    fireEvent.click(screen.getByTestId("create-collection-submit"));

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/bundle-sync/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "synced-docs",
      endpoint_url: "https://kb.example.com/bundle.tar.gz",
      auth_scheme: "none",
    });
    expect(onCreated).toHaveBeenCalledWith("synced-docs", "bundle-sync");
  });

  test("sync source requires an endpoint before submitting", () => {
    renderDialog();
    switchToSync();
    fireEvent.change(screen.getByTestId("collection-slug"), { target: { value: "synced-docs" } });
    const submit = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  test("duplicate slugs stay blocked on both sources", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("collection-slug"), { target: { value: "taken" } });
    const submit = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe("CreateCollectionDialog edit mode (sync-settings rotation)", () => {
  function renderEdit(onCreated = mock(() => {})) {
    render(
      <CreateCollectionDialog
        open
        onOpenChange={() => {}}
        onCreated={onCreated}
        existingSlugs={[]}
        edit={{
          slug: "synced-docs",
          endpointUrl: "https://kb.example.com/bundle.tar.gz",
          authScheme: "bearer",
          description: "Docs mirror",
        }}
      />,
    );
    return onCreated;
  }

  test("re-drives the bundle-sync install with the EXISTING slug — rotating the secret in place", async () => {
    const onCreated = renderEdit();
    // Endpoint + scheme pre-filled from the collection; secret starts blank
    // (never echoed) and is required for bearer.
    const submit = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("collection-secret"), {
      target: { value: "new-rotated-token" },
    });
    fireEvent.click(screen.getByTestId("create-collection-submit"));

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/v1/integrations/bundle-sync/install-form");
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "synced-docs",
      description: "Docs mirror",
      endpoint_url: "https://kb.example.com/bundle.tar.gz",
      auth_scheme: "bearer",
      auth_secret: "new-rotated-token",
    });
    expect(onCreated).toHaveBeenCalledWith("synced-docs", "bundle-sync");
  });

  test("a none-scheme edit needs no secret and posts auth_scheme none (no stray auth_secret)", async () => {
    const onCreated = mock(() => {});
    render(
      <CreateCollectionDialog
        open
        onOpenChange={() => {}}
        onCreated={onCreated}
        existingSlugs={[]}
        edit={{
          slug: "public-docs",
          endpointUrl: "https://kb.example.com/public.zip",
          authScheme: "none",
          description: null,
        }}
      />,
    );
    const submit = screen.getByTestId("create-collection-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false); // no secret required for a public endpoint
    fireEvent.click(submit);

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].body).toEqual({
      __install_id__: "public-docs",
      endpoint_url: "https://kb.example.com/public.zip",
      auth_scheme: "none",
    });
    expect(onCreated).toHaveBeenCalledWith("public-docs", "bundle-sync");
  });

  test("edit mode hides the slug/source pickers — the identity is fixed", () => {
    renderEdit();
    expect(screen.queryByTestId("collection-slug")).toBeNull();
    expect(screen.queryByTestId("source-upload")).toBeNull();
  });
});
