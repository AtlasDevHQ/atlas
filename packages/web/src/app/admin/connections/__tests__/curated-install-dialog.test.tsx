/**
 * Secret-isolation coverage for the curated REST datasource install dialog.
 *
 * The dialog is a single long-lived instance reused across vendors (the page
 * swaps `candidate` rather than remounting). Its only guard against a pasted
 * credential bleeding from one vendor's install into the next is the
 * reset-on-open effect keyed on `[open, candidate?.slug]`. A regression there
 * (e.g. narrowing the dep array, or hoisting the field state) would silently
 * POST a live secret — say a Stripe `sk_live_…` — against a *different*
 * vendor's `install-form` endpoint. That's invisible to type-checking and to a
 * casual smoke test, so it's asserted here directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
