import { describe, it, expect } from "bun:test";
import { parseCreateOrgError } from "./parse-create-org-error";

describe("parseCreateOrgError — partial activation branch", () => {
  it("classifies partialActivation as partial_activation regardless of other inputs", () => {
    const out = parseCreateOrgError({
      partialActivation: true,
      // Even with a server error or thrown alongside, partial_activation wins
      // because the org *was* created and that's the user-actionable truth.
      error: { status: 500, message: "ignored" },
      thrown: new Error("ignored"),
    });
    expect(out.kind).toBe("partial_activation");
    expect(out.body).toMatch(/reload/i);
  });
});

describe("parseCreateOrgError — thrown branch", () => {
  it("classifies TypeError as network", () => {
    const out = parseCreateOrgError({ thrown: new TypeError("fetch failed") });
    expect(out.kind).toBe("network");
    expect(out.title).toMatch(/can't reach/i);
  });

  it("classifies generic Error as unknown with the message body", () => {
    const out = parseCreateOrgError({ thrown: new Error("boom") });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("boom");
  });

  it("classifies non-Error thrown values as unknown via String(...)", () => {
    const out = parseCreateOrgError({ thrown: "weird-string-error" });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("weird-string-error");
  });

  it("uses the fallback body when thrown has empty message", () => {
    const out = parseCreateOrgError({ thrown: new Error("") });
    expect(out.kind).toBe("unknown");
    expect(out.body).toMatch(/contact support/i);
  });
});

describe("parseCreateOrgError — response branch", () => {
  it("classifies 409 as slug_taken with /already in use/i title (renderer contract)", () => {
    const out = parseCreateOrgError({
      error: { status: 409, message: "Slug already exists" },
    });
    expect(out.kind).toBe("slug_taken");
    expect(out.title).toMatch(/already in use/i);
  });

  it("classifies SLUG_ALREADY_EXISTS code as slug_taken", () => {
    const out = parseCreateOrgError({
      error: { code: "SLUG_ALREADY_EXISTS" },
    });
    expect(out.kind).toBe("slug_taken");
  });

  it("classifies status 403 as permission_denied", () => {
    const out = parseCreateOrgError({ error: { status: 403 } });
    expect(out.kind).toBe("permission_denied");
  });

  it("classifies code FORBIDDEN as permission_denied", () => {
    const out = parseCreateOrgError({ error: { code: "FORBIDDEN" } });
    expect(out.kind).toBe("permission_denied");
  });

  it("classifies status 402 as billing_required", () => {
    const out = parseCreateOrgError({ error: { status: 402 } });
    expect(out.kind).toBe("billing_required");
  });

  it("classifies PLAN_LIMIT_REACHED as billing_required", () => {
    const out = parseCreateOrgError({ error: { code: "PLAN_LIMIT_REACHED" } });
    expect(out.kind).toBe("billing_required");
  });

  it("falls back to unknown for unfamiliar shapes, surfacing the message", () => {
    const out = parseCreateOrgError({
      error: { message: "totally novel server error" },
    });
    expect(out.kind).toBe("unknown");
    expect(out.body).toBe("totally novel server error");
  });

  it("falls back to unknown with actionable copy when the message is empty", () => {
    const out = parseCreateOrgError({ error: {} });
    expect(out.kind).toBe("unknown");
    expect(out.body).toMatch(/contact support/i);
  });
});

describe("parseCreateOrgError — branch ordering invariants", () => {
  it("a 403 whose message mentions 'slug' still routes to permission_denied (status leads)", () => {
    const out = parseCreateOrgError({
      error: { status: 403, message: "Slug already exists" },
    });
    expect(out.kind).toBe("permission_denied");
  });

  it("a 402 whose message mentions 'forbidden' still routes to billing_required (status leads)", () => {
    const out = parseCreateOrgError({
      error: { status: 402, message: "forbidden plan" },
    });
    expect(out.kind).toBe("billing_required");
  });

  it("a SLUG_ALREADY_EXISTS code paired with a generic message still routes to slug_taken", () => {
    const out = parseCreateOrgError({
      error: { code: "SLUG_ALREADY_EXISTS", message: "Conflict" },
    });
    expect(out.kind).toBe("slug_taken");
  });
});
