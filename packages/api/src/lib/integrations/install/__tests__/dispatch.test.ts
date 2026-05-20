/**
 * Tests for `getInstallHandler` dispatch — slice 4 of #2649 (issue #2652).
 *
 * Asserted invariants (per #2652 ACs):
 *
 *   - Each `install_model` value returns the correct handler shape
 *   - `static-bot` returns the stub
 *   - The stub's `confirmInstall` throws an actionable "not implemented
 *     until 1.5.3 — see milestone #51" error
 *   - An unknown `install_model` value is a compile error at the
 *     dispatch switch (demonstrated via a `@ts-expect-error`)
 *
 * The dispatch shape is the load-bearing part of this slice: slice 5
 * (Slack) and #2660 (form-based) drop their handlers in by calling
 * `registerOAuthHandler` / `registerFormHandler` at module load.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetInstallHandlerRegistries,
  getInstallHandler,
  registerFormHandler,
  registerOAuthHandler,
} from "../dispatch";
import type {
  CatalogRowForDispatch,
  FormBasedInstallHandler,
  InstallRecord,
  OAuthPlatformInstallHandler,
} from "../types";
import { staticBotInstallHandlerStub } from "../static-bot-stub";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const wsid = "org-test" as WorkspaceId;

function makeOAuthHandler(slug: string): OAuthPlatformInstallHandler {
  const record: InstallRecord = { id: `install-${slug}`, workspaceId: wsid, catalogId: slug };
  return {
    kind: "oauth",
    async startInstall() {
      return { redirectUrl: `https://example.test/${slug}/authorize`, stateToken: "tok" };
    },
    async handleCallback() {
      return {
        workspaceId: wsid,
        catalogId: slug,
        installRecord: record,
        credentialResult: { written: true },
      };
    },
  };
}

function makeFormHandler(slug: string): FormBasedInstallHandler {
  const record: InstallRecord = { id: `install-${slug}`, workspaceId: wsid, catalogId: slug };
  return {
    kind: "form",
    async validateConfig() {
      return { installRecord: record, credentialWritten: true };
    },
  };
}

afterEach(() => {
  _resetInstallHandlerRegistries();
});

// ---------------------------------------------------------------------------
// Per-`install_model` dispatch
// ---------------------------------------------------------------------------

describe("getInstallHandler — install_model: 'oauth'", () => {
  it("returns the registered OAuth handler for a known slug", () => {
    const handler = makeOAuthHandler("slack");
    registerOAuthHandler("slack", handler);

    const row: CatalogRowForDispatch = { slug: "slack", install_model: "oauth" };
    const resolved = getInstallHandler(row);
    expect(resolved.kind).toBe("oauth");
    expect(resolved).toBe(handler);
  });

  it("throws when no OAuth handler is registered for the slug", () => {
    const row: CatalogRowForDispatch = { slug: "slack", install_model: "oauth" };
    expect(() => getInstallHandler(row)).toThrow(
      /No OAuth install handler registered for catalog slug "slack"/,
    );
  });

  it("treats re-registration as overwrite (test ergonomics)", () => {
    registerOAuthHandler("slack", makeOAuthHandler("slack-v1"));
    const replacement = makeOAuthHandler("slack-v2");
    registerOAuthHandler("slack", replacement);

    const row: CatalogRowForDispatch = { slug: "slack", install_model: "oauth" };
    expect(getInstallHandler(row)).toBe(replacement);
  });
});

describe("getInstallHandler — install_model: 'form'", () => {
  it("returns the registered form handler for a known slug", () => {
    const handler = makeFormHandler("email");
    registerFormHandler("email", handler);

    const row: CatalogRowForDispatch = { slug: "email", install_model: "form" };
    const resolved = getInstallHandler(row);
    expect(resolved.kind).toBe("form");
    expect(resolved).toBe(handler);
  });

  it("throws when no form handler is registered for the slug", () => {
    const row: CatalogRowForDispatch = { slug: "email", install_model: "form" };
    expect(() => getInstallHandler(row)).toThrow(
      /No form-based install handler registered for catalog slug "email"/,
    );
  });
});

describe("getInstallHandler — install_model: 'static-bot'", () => {
  it("always returns the operator-shared stub", () => {
    const row: CatalogRowForDispatch = { slug: "telegram", install_model: "static-bot" };
    expect(getInstallHandler(row)).toBe(staticBotInstallHandlerStub);
  });

  it("returns the same stub regardless of slug — bot is operator-shared", () => {
    const tg: CatalogRowForDispatch = { slug: "telegram", install_model: "static-bot" };
    const discord: CatalogRowForDispatch = { slug: "discord", install_model: "static-bot" };
    expect(getInstallHandler(tg)).toBe(getInstallHandler(discord));
  });
});

describe("StaticBotInstallHandler stub", () => {
  it("throws the actionable 1.5.3 deferral when confirmInstall is called", async () => {
    await expect(
      staticBotInstallHandlerStub.confirmInstall(wsid, "guild-123"),
    ).rejects.toThrow(/not implemented until 1\.5\.3.*milestone #51/);
  });

  it("identifies itself with kind: 'static-bot' for narrowing", () => {
    expect(staticBotInstallHandlerStub.kind).toBe("static-bot");
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness
// ---------------------------------------------------------------------------

describe("getInstallHandler — compile-time exhaustiveness", () => {
  it("rejects unknown install_model values at the type level", () => {
    // @ts-expect-error — "manifest" isn't in CatalogInstallModel; this
    // line MUST be flagged by tsc/tsgo. If a future migration extends
    // the enum without updating the dispatch switch, that error fires
    // at the `_exhaustive: never` branch in `getInstallHandler` instead.
    const row: CatalogRowForDispatch = { slug: "future", install_model: "manifest" };
    // The runtime check is a defense-in-depth — if a regression bypasses
    // the type system, the default branch throws so we don't silently
    // dispatch nothing.
    expect(() => getInstallHandler(row)).toThrow(/Unknown install_model "manifest"/);
  });
});
