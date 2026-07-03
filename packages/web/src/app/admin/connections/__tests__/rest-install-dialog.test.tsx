/**
 * Coverage for the Custom REST API install dialog after it was converged onto
 * the shared {@link FormDialog} primitive (#4203).
 *
 * Two things this locks:
 *   1. The dialog still POSTs the exact `install-form` wire body (spec URL +
 *      auth) — the FormDialog refactor must not reshape the payload.
 *   2. A failed install surfaces the server's message through FormDialog's
 *      shared root-error banner. This is the "a validation/error-surface fix
 *      in one install dialog reaches all of them" acceptance criterion:
 *      RestInstallDialog no longer owns a bespoke `useState<error>` +
 *      `<InlineError>` — the banner is FormDialog's, shared with the curated /
 *      BYOT / catalog install dialogs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RestInstallDialog, buildRestInstallBody } from "../openapi-block";

const noop = () => undefined;

// The conditional wire-body shaping is the most substantive new logic in the
// dialog and is driven by `auth_kind` — which is painful to exercise through
// the Radix Select in jsdom. `buildRestInstallBody` is extracted precisely so
// each auth kind's payload is asserted deterministically here.
describe("buildRestInstallBody", () => {
  const base = {
    openapi_url: "  https://api.example.com/openapi.json  ",
    auth_kind: "bearer",
    auth_value: "tok",
    auth_header_name: "X-API-Key",
    auth_param_name: "api_key",
    base_url_override: "",
    display_name: "",
  };

  test("trims openapi_url and includes auth_value for bearer (no header/param)", () => {
    expect(buildRestInstallBody(base)).toEqual({
      openapi_url: "https://api.example.com/openapi.json",
      auth_kind: "bearer",
      auth_value: "tok",
    });
  });

  test("omits auth_value entirely for auth_kind=none", () => {
    const body = buildRestInstallBody({ ...base, auth_kind: "none" });
    expect(body).toEqual({
      openapi_url: "https://api.example.com/openapi.json",
      auth_kind: "none",
    });
    expect("auth_value" in body).toBe(false);
  });

  test("apikey-header carries auth_header_name but not auth_param_name", () => {
    const body = buildRestInstallBody({ ...base, auth_kind: "apikey-header" });
    expect(body.auth_header_name).toBe("X-API-Key");
    expect(body.auth_value).toBe("tok");
    expect("auth_param_name" in body).toBe(false);
  });

  test("apikey-query carries auth_param_name but not auth_header_name", () => {
    const body = buildRestInstallBody({ ...base, auth_kind: "apikey-query" });
    expect(body.auth_param_name).toBe("api_key");
    expect("auth_header_name" in body).toBe(false);
  });

  test("drops blank optional fields and trims populated ones", () => {
    const blank = buildRestInstallBody(base);
    expect("base_url_override" in blank).toBe(false);
    expect("display_name" in blank).toBe(false);

    const populated = buildRestInstallBody({
      ...base,
      base_url_override: "  https://staging.example.com/rest  ",
      display_name: "  Twenty CRM  ",
    });
    expect(populated.base_url_override).toBe("https://staging.example.com/rest");
    expect(populated.display_name).toBe("Twenty CRM");
  });
});

describe("RestInstallDialog", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string; body: unknown }>;
  let nextResponse: () => Response;

  beforeEach(() => {
    fetchCalls = [];
    nextResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, method, body });
      return Promise.resolve(nextResponse());
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("POSTs the spec URL + auth body to /install-form and fires onInstalled", async () => {
    let installed = false;
    render(
      <RestInstallDialog open onOpenChange={noop} onInstalled={() => (installed = true)} />,
    );

    await act(async () => {
      fireEvent.change(screen.getByTestId("openapi-url-input"), {
        target: { value: "https://api.example.com/openapi.json" },
      });
    });
    // auth_kind defaults to "bearer", so the token field is disclosed.
    await act(async () => {
      fireEvent.change(screen.getByTestId("openapi-auth-value"), {
        target: { value: "secret-token" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("openapi-install-submit"));
    });

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === "POST" && c.url.endsWith("/api/v1/integrations/openapi-generic/install-form"),
      );
      expect(call).toBeDefined();
      expect(call?.body).toEqual({
        openapi_url: "https://api.example.com/openapi.json",
        auth_kind: "bearer",
        auth_value: "secret-token",
      });
    });
    expect(installed).toBe(true);
  });

  test("surfaces a failed install through FormDialog's shared error banner", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ message: "Spec probe failed", requestId: "abcdef1234567890" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    render(<RestInstallDialog open onOpenChange={noop} onInstalled={noop} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("openapi-url-input"), {
        target: { value: "https://bad.example.com/openapi.json" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("openapi-install-submit"));
    });

    // The message (with the short request-id tail) renders in the shared banner.
    expect(await screen.findByText("Spec probe failed (ref: abcdef12)")).toBeDefined();
  });

  test("client-validates a blank spec URL before hitting the network", async () => {
    render(<RestInstallDialog open onOpenChange={noop} onInstalled={noop} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("openapi-install-submit"));
    });

    expect(await screen.findByText("OpenAPI spec URL is required")).toBeDefined();
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });
});
