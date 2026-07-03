/**
 * Secret-isolation coverage for the curated REST datasource install dialog.
 *
 * The dialog is a single long-lived instance reused across vendors (the page
 * swaps `candidate` rather than remounting). Since #4203 it rides `FormDialog`,
 * whose reset-on-open effect is keyed on `[open, resetKey]`; the dialog passes
 * `resetKey={candidate.slug}`, so switching vendors while open wipes the field.
 * A regression there (e.g. dropping the `resetKey` prop, or FormDialog
 * narrowing its effect deps) would silently POST a live secret — say a Stripe
 * `sk_live_…` — against a *different* vendor's `install-form` endpoint. That's
 * invisible to type-checking and to a casual smoke test, so it's asserted here
 * directly against observable field state (not the implementation).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CuratedInstallDialog, type CuratedCandidate } from "../curated-install-dialog";

const STRIPE: CuratedCandidate = { slug: "stripe-data", name: "Stripe", description: null };
const NOTION: CuratedCandidate = { slug: "notion-data", name: "Notion", description: null };

const noop = () => undefined;

function authInput(): HTMLInputElement {
  return screen.getByTestId("curated-auth-value") as HTMLInputElement;
}

afterEach(cleanup);

describe("CuratedInstallDialog secret isolation", () => {
  test("clears the credential when the candidate changes (no bleed across vendors)", () => {
    const { rerender } = render(
      <CuratedInstallDialog candidate={STRIPE} open onOpenChange={noop} onInstalled={noop} />,
    );

    fireEvent.change(authInput(), { target: { value: "sk_live_super_secret" } });
    expect(authInput().value).toBe("sk_live_super_secret");

    // Same dialog instance, different vendor — the slug-keyed reset must wipe
    // the previously pasted Stripe key before the Notion install form is shown.
    rerender(
      <CuratedInstallDialog candidate={NOTION} open onOpenChange={noop} onInstalled={noop} />,
    );
    expect(authInput().value).toBe("");
  });

  test("clears the credential on close-then-reopen for the same vendor", () => {
    const { rerender } = render(
      <CuratedInstallDialog candidate={STRIPE} open onOpenChange={noop} onInstalled={noop} />,
    );

    fireEvent.change(authInput(), { target: { value: "sk_live_x" } });
    expect(authInput().value).toBe("sk_live_x");

    // Closing then reopening the same candidate re-fires the open-gated reset,
    // so a half-typed secret never survives a dismiss.
    rerender(
      <CuratedInstallDialog candidate={STRIPE} open={false} onOpenChange={noop} onInstalled={noop} />,
    );
    rerender(
      <CuratedInstallDialog candidate={STRIPE} open onOpenChange={noop} onInstalled={noop} />,
    );
    expect(authInput().value).toBe("");
  });
});

describe("CuratedInstallDialog error surface (rides FormDialog)", () => {
  const originalFetch = globalThis.fetch;
  let nextResponse: () => Response;

  beforeEach(() => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = mock(() => Promise.resolve(nextResponse())) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  // A failed install surfaces through FormDialog's shared root-error banner —
  // the same banner the REST / BYOT / catalog install dialogs use. This is the
  // "a validation/error-surface fix reaches all of them" acceptance criterion.
  test("surfaces a failed install through the shared FormDialog banner", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: "Invalid API key", requestId: "deadbeefcafe" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    render(<CuratedInstallDialog candidate={STRIPE} open onOpenChange={noop} onInstalled={noop} />);

    await act(async () => {
      fireEvent.change(authInput(), { target: { value: "sk_live_bad" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("curated-install-submit"));
    });

    expect(await screen.findByText("Invalid API key (ref: deadbeef)")).toBeDefined();
  });
});
