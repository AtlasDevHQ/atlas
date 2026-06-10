/**
 * Tests for the shared lazy-plugin-tool scaffolding (#3326).
 *
 * The per-tool ladders (status discriminants, remediation copy) are covered
 * end-to-end by `email-tool.test.ts` / `linear-tool.test.ts` /
 * `salesforce-tool.test.ts`; these tests pin the shared pieces those tools
 * compose: the instantiate helper's `null`-vs-rethrow contract, the error
 * classifier's mapping, and the deps-defaulting seam.
 */

import { describe, expect, it } from "bun:test";

import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";
import {
  classifyLazyInstantiateError,
  defaultResolveRequestId,
  defaultResolveWorkspaceId,
  resolveLazyPluginToolDeps,
  tryInstantiate,
} from "../lazy-plugin-tool";

const WSID = "ws-lazy-plugin-tool-test";
const CATALOG = "catalog:test";

function makeLoader(
  outcome: PluginLike | Error,
): Pick<LazyPluginLoader, "getOrInstantiate"> {
  return {
    getOrInstantiate: (async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as LazyPluginLoader["getOrInstantiate"],
  };
}

const fakeInstance = { id: "test:instance", types: ["action"], version: "0.0.0", name: "Test" } as unknown as PluginLike;

describe("tryInstantiate", () => {
  it("returns the instance on success", async () => {
    const result = await tryInstantiate<PluginLike>(makeLoader(fakeInstance), WSID, CATALOG);
    expect(result).toBe(fakeInstance);
  });

  it("returns null on LazyPluginInstallNotFoundError", async () => {
    const loader = makeLoader(new LazyPluginInstallNotFoundError(WSID, CATALOG));
    const result = await tryInstantiate<PluginLike>(loader, WSID, CATALOG);
    expect(result).toBeNull();
  });

  it("rethrows every other error class for the caller's status ladder", async () => {
    const builderMissing = new LazyPluginBuilderMissingError(CATALOG);
    await expect(
      tryInstantiate<PluginLike>(makeLoader(builderMissing), WSID, CATALOG),
    ).rejects.toBe(builderMissing);

    const plain = new Error("decrypt blew up");
    await expect(
      tryInstantiate<PluginLike>(makeLoader(plain), WSID, CATALOG),
    ).rejects.toBe(plain);
  });
});

describe("classifyLazyInstantiateError", () => {
  it("maps LazyPluginInstallNotFoundError to install_not_found", () => {
    expect(
      classifyLazyInstantiateError(new LazyPluginInstallNotFoundError(WSID, CATALOG)),
    ).toBe("install_not_found");
  });

  it("maps IntegrationReconnectRequiredError to reconnect_required", () => {
    const err = new IntegrationReconnectRequiredError({
      message: "refresh failed permanently",
      workspaceId: WSID,
      platform: "salesforce",
      upstreamError: "invalid_grant",
    });
    expect(classifyLazyInstantiateError(err)).toBe("reconnect_required");
  });

  it("maps LazyPluginBuilderMissingError to builder_missing", () => {
    expect(classifyLazyInstantiateError(new LazyPluginBuilderMissingError(CATALOG))).toBe(
      "builder_missing",
    );
  });

  it("maps everything else (tool-specific classes, plain errors, non-Errors) to unknown", () => {
    class ToolSpecificError extends Error {}
    expect(classifyLazyInstantiateError(new ToolSpecificError("x"))).toBe("unknown");
    expect(classifyLazyInstantiateError(new Error("plain"))).toBe("unknown");
    expect(classifyLazyInstantiateError("a string")).toBe("unknown");
    expect(classifyLazyInstantiateError(undefined)).toBe("unknown");
  });
});

describe("resolveLazyPluginToolDeps", () => {
  it("keeps injected deps", () => {
    const loader = makeLoader(fakeInstance);
    const resolveWorkspaceId = () => WSID;
    const resolveRequestId = () => "req-1";
    const resolved = resolveLazyPluginToolDeps({ loader, resolveWorkspaceId, resolveRequestId });
    expect(resolved.loader).toBe(loader);
    expect(resolved.resolveWorkspaceId).toBe(resolveWorkspaceId);
    expect(resolved.resolveRequestId).toBe(resolveRequestId);
  });

  it("falls back to the production defaults for omitted deps", () => {
    const resolved = resolveLazyPluginToolDeps({});
    expect(resolved.resolveWorkspaceId).toBe(defaultResolveWorkspaceId);
    expect(resolved.resolveRequestId).toBe(defaultResolveRequestId);
    expect(typeof resolved.loader.getOrInstantiate).toBe("function");
  });

  it("default resolvers return undefined outside a request context", () => {
    expect(defaultResolveWorkspaceId()).toBeUndefined();
    expect(defaultResolveRequestId()).toBeUndefined();
  });
});
