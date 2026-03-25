import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import {
  RequestContext,
  makeRequestContextLayer,
  createRequestContextTestLayer,
  AuthContext,
  makeAuthContextLayer,
  createAuthContextTestLayer,
} from "../services";

// ── RequestContext ──────────────────────────────────────────────────

describe("RequestContext", () => {
  test("makeRequestContextLayer provides requestId and startTime", async () => {
    const layer = makeRequestContextLayer("req-123", 1000);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.requestId).toBe("req-123");
    expect(result.startTime).toBe(1000);
  });

  test("makeRequestContextLayer defaults startTime to now", async () => {
    const before = Date.now();
    const layer = makeRequestContextLayer("req-456");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.startTime;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(Date.now());
  });

  test("createRequestContextTestLayer provides defaults", async () => {
    const layer = createRequestContextTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.requestId).toBe("test-request-id");
    expect(typeof result.startTime).toBe("number");
  });

  test("createRequestContextTestLayer accepts overrides", async () => {
    const layer = createRequestContextTestLayer({ requestId: "custom-id" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.requestId;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("custom-id");
  });
});

// ── AuthContext ─────────────────────────────────────────────────────

describe("AuthContext", () => {
  test("makeAuthContextLayer provides mode, user, and orgId", async () => {
    const user = {
      id: "user-1",
      mode: "managed" as const,
      label: "test@example.com",
      role: "admin" as const,
      activeOrganizationId: "org-abc",
    };
    const layer = makeAuthContextLayer("managed", user);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* AuthContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.mode).toBe("managed");
    expect(result.user?.id).toBe("user-1");
    expect(result.orgId).toBe("org-abc");
  });

  test("makeAuthContextLayer handles none mode with undefined user", async () => {
    const layer = makeAuthContextLayer("none", undefined);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* AuthContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.mode).toBe("none");
    expect(result.user).toBeUndefined();
    expect(result.orgId).toBeUndefined();
  });

  test("makeAuthContextLayer derives orgId from user", async () => {
    const user = {
      id: "user-2",
      mode: "byot" as const,
      label: "jwt-user",
      activeOrganizationId: "org-xyz",
    };
    const layer = makeAuthContextLayer("byot", user);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* AuthContext;
        return ctx.orgId;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("org-xyz");
  });

  test("createAuthContextTestLayer provides defaults", async () => {
    const layer = createAuthContextTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* AuthContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.mode).toBe("none");
    expect(result.user).toBeUndefined();
    expect(result.orgId).toBeUndefined();
  });

  test("createAuthContextTestLayer accepts overrides", async () => {
    const layer = createAuthContextTestLayer({
      mode: "managed",
      orgId: "test-org",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* AuthContext;
        return ctx;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.mode).toBe("managed");
    expect(result.orgId).toBe("test-org");
  });
});

// ── Combined Context ───────────────────────────────────────────────

describe("Combined RequestContext + AuthContext", () => {
  test("both contexts available in same Effect program", async () => {
    const reqLayer = makeRequestContextLayer("req-combined", 5000);
    const authLayer = makeAuthContextLayer("managed", {
      id: "u1",
      mode: "managed" as const,
      label: "admin@test.com",
      role: "admin" as const,
      activeOrganizationId: "org-1",
    });
    const combined = Layer.merge(reqLayer, authLayer);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        const auth = yield* AuthContext;
        return { requestId: req.requestId, orgId: auth.orgId };
      }).pipe(Effect.provide(combined)),
    );

    expect(result.requestId).toBe("req-combined");
    expect(result.orgId).toBe("org-1");
  });

  test("test helpers compose together", async () => {
    const combined = Layer.merge(
      createRequestContextTestLayer({ requestId: "test-req" }),
      createAuthContextTestLayer({ mode: "byot", orgId: "test-org" }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        const auth = yield* AuthContext;
        return `${req.requestId}:${auth.orgId}`;
      }).pipe(Effect.provide(combined)),
    );

    expect(result).toBe("test-req:test-org");
  });
});
