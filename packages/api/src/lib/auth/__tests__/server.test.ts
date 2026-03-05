import { describe, it, expect, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { resetAuthInstance } from "../server";

describe("Better Auth instance shape", () => {
  afterEach(() => {
    resetAuthInstance();
  });

  it("betterAuth() with @better-auth/api-key returns expected shape", async () => {
    // Verify the `as unknown as AuthInstance` cast in server.ts doesn't
    // hide a missing property. This uses the real betterAuth() constructor
    // with the same plugins as production.
    const instance = betterAuth({
      // Minimal adapter stub — enough for construction, never queried.
      database: {
        db: null,
        type: "sqlite",
      } as unknown as Parameters<typeof betterAuth>[0]["database"],
      secret: "test-secret-at-least-32-characters-long",
      plugins: [bearer(), apiKey()],
    });

    expect(typeof instance.handler).toBe("function");
    expect(typeof instance.api.getSession).toBe("function");
    expect(instance.$context).toBeInstanceOf(Promise);

    // Drain the $context promise so the async DB adapter init error
    // doesn't surface as an unhandled rejection after the test ends.
    await instance.$context.catch(() => {});
  });
});
