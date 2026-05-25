/**
 * Tests for `getInstallHandler` dispatch — slice 4 of #2649 (issue #2652),
 * updated in 1.5.3 #2748 (Telegram keystone) to swap the single static-bot
 * stub for a per-slug registry parallel to oauth/form.
 *
 * Asserted invariants:
 *
 *   - Each `install_model` value returns the correct handler shape via a
 *     per-slug registry (oauth / form / static-bot all behave the same).
 *   - Missing-handler throws an actionable error naming the slug + the
 *     register helper to call (no silent dispatch into a no-op).
 *   - An unknown `install_model` value is a compile error at the
 *     dispatch switch (demonstrated via a `@ts-expect-error`).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetInstallHandlerRegistries,
  getInstallHandler,
  registerFormHandler,
  registerOAuthHandler,
  registerStaticBotHandler,
} from "../dispatch";
import type {
  CatalogRowForDispatch,
  FormBasedInstallHandler,
  InstallRecord,
  OAuthPlatformInstallHandler,
  StaticBotInstallHandler,
} from "../types";
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

function makeStaticBotHandler(slug: string): StaticBotInstallHandler {
  const record: InstallRecord = { id: `install-${slug}`, workspaceId: wsid, catalogId: slug };
  return {
    kind: "static-bot",
    async confirmInstall() {
      return { installRecord: record };
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
  it("returns the registered static-bot handler for a known slug", () => {
    const handler = makeStaticBotHandler("telegram");
    registerStaticBotHandler("telegram", handler);

    const row: CatalogRowForDispatch = { slug: "telegram", install_model: "static-bot" };
    const resolved = getInstallHandler(row);
    expect(resolved.kind).toBe("static-bot");
    expect(resolved).toBe(handler);
  });

  it("dispatches per-slug — telegram, discord, and gchat are independent slots", () => {
    const tg = makeStaticBotHandler("telegram");
    const discord = makeStaticBotHandler("discord");
    const gchat = makeStaticBotHandler("gchat");
    registerStaticBotHandler("telegram", tg);
    registerStaticBotHandler("discord", discord);
    registerStaticBotHandler("gchat", gchat);

    expect(
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }),
    ).toBe(tg);
    expect(
      getInstallHandler({ slug: "discord", install_model: "static-bot" }),
    ).toBe(discord);
    expect(
      getInstallHandler({ slug: "gchat", install_model: "static-bot" }),
    ).toBe(gchat);
  });

  it("throws an actionable error when no static-bot handler is registered for the slug", () => {
    const row: CatalogRowForDispatch = { slug: "telegram", install_model: "static-bot" };
    expect(() => getInstallHandler(row)).toThrow(
      /No static-bot install handler registered for catalog slug "telegram"/,
    );
    // The error message names the env-gate guidance so operators don't
    // have to grep the codebase to discover why a catalog row went dark.
    expect(() => getInstallHandler(row)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("treats re-registration as overwrite (test ergonomics)", () => {
    registerStaticBotHandler("telegram", makeStaticBotHandler("telegram-v1"));
    const replacement = makeStaticBotHandler("telegram-v2");
    registerStaticBotHandler("telegram", replacement);

    expect(
      getInstallHandler({ slug: "telegram", install_model: "static-bot" }),
    ).toBe(replacement);
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
