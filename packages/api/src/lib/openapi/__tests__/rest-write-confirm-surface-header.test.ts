/**
 * #5495 — the confirm-before-write SURFACE declaration.
 *
 * `executeRestOperation` stages an allowlisted write as `needs_confirmation` and
 * relies on the chat surface to render a banner that POSTs the payload to
 * `/api/v1/rest-operations/confirm`. Exactly one thing in the tree does that
 * (`packages/web/.../rest-write-confirm-card.tsx`), while `POST /api/v1/chat` is
 * also the embeddable `@useatlas/react` widget's endpoint — so a widget user was
 * asked to confirm something no UI could confirm.
 *
 * These pin the DEFAULT, which is the half of the gate that does the work: it is
 * what makes already-published widget versions correct without an upgrade.
 */
import { describe, it, expect } from "bun:test";

import {
  WRITE_CONFIRM_UI_HEADER,
  readsWriteConfirmUiHeader,
} from "@atlas/api/lib/openapi/rest-write-confirm";

const h = (v?: string): Headers => (v === undefined ? new Headers() : new Headers({ [WRITE_CONFIRM_UI_HEADER]: v }));

describe("readsWriteConfirmUiHeader (#5495)", () => {
  it("is FALSE when the header is absent — the shape every published widget sends", () => {
    expect(readsWriteConfirmUiHeader(h())).toBe(false);
  });

  it("accepts the values the web transports actually send", () => {
    expect(readsWriteConfirmUiHeader(h("1"))).toBe(true);
    expect(readsWriteConfirmUiHeader(h("true"))).toBe(true);
    expect(readsWriteConfirmUiHeader(h("TRUE"))).toBe(true);
    expect(readsWriteConfirmUiHeader(h(" 1 "))).toBe(true);
  });

  it("refuses anything else rather than guessing — an unknown value is not a declaration", () => {
    for (const v of ["", "0", "false", "yes", "on", "y", "2", "null", "undefined"]) {
      expect(readsWriteConfirmUiHeader(h(v)), `"${v}" must not declare the banner`).toBe(false);
    }
  });

  it("names the header the web transports and the CORS allowlist are written against", () => {
    // A rename here silently disarms both web surfaces (they carry string
    // literals — the frontend cannot import from @atlas/api) and the preflight.
    expect(WRITE_CONFIRM_UI_HEADER).toBe("x-atlas-write-confirm-ui");
  });
});
