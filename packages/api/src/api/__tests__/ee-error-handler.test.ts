import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { EnterpriseError } from "@atlas/ee/index";
import { throwIfEEError, eeOnError } from "../routes/ee-error-handler";

// ---------------------------------------------------------------------------
// Test domain error classes (mirrors real EE error classes)
// ---------------------------------------------------------------------------

class FakeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FakeError";
  }
}

class OtherFakeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "OtherFakeError";
  }
}

const STATUS_MAP = { validation: 400, not_found: 404, conflict: 409 } as const;
const OTHER_STATUS_MAP = { expired: 410, forbidden: 403 } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catchHTTPException(fn: () => void): HTTPException | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof HTTPException) return err;
    throw err;
  }
}

async function parseBody(ex: HTTPException): Promise<{ error: string; message: string }> {
  const res = ex.res!;
  return res.json() as Promise<{ error: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("throwIfEEError", () => {
  test("EnterpriseError maps to 403 with enterprise_required", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(new EnterpriseError("License required"), [FakeError, STATUS_MAP]),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(403);
    const body = await parseBody(ex!);
    expect(body.error).toBe("enterprise_required");
    expect(body.message).toBe("License required");
  });

  test("domain error maps to status from statusMap", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(new FakeError("Not found", "not_found"), [FakeError, STATUS_MAP]),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(404);
    const body = await parseBody(ex!);
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Not found");
  });

  test("domain error with conflict code maps to 409", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(new FakeError("Already exists", "conflict"), [FakeError, STATUS_MAP]),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(409);
  });

  test("unmapped domain error code defaults to 400", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(new FakeError("Unknown code", "unknown_code"), [FakeError, STATUS_MAP]),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(400);
    const body = await parseBody(ex!);
    expect(body.error).toBe("unknown_code");
  });

  test("unknown error falls through without throwing", () => {
    const genericError = new Error("Something unexpected");
    // Should not throw — falls through for the caller to handle
    throwIfEEError(genericError, [FakeError, STATUS_MAP]);
  });

  test("multiple domain error mappings — first match wins", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(
        new OtherFakeError("Token expired", "expired"),
        [FakeError, STATUS_MAP],
        [OtherFakeError, OTHER_STATUS_MAP],
      ),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(410);
    const body = await parseBody(ex!);
    expect(body.error).toBe("expired");
  });

  test("multiple mappings — first class checked first", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(
        new FakeError("Bad input", "validation"),
        [FakeError, STATUS_MAP],
        [OtherFakeError, OTHER_STATUS_MAP],
      ),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(400);
  });

  test("EnterpriseError takes priority over domain errors", async () => {
    const ex = catchHTTPException(() =>
      throwIfEEError(new EnterpriseError(), [FakeError, STATUS_MAP]),
    );
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(403);
  });

  test("no mappings — only EnterpriseError handled", async () => {
    const ex = catchHTTPException(() => throwIfEEError(new EnterpriseError()));
    expect(ex).not.toBeNull();
    expect(ex!.status).toBe(403);

    // Non-enterprise error falls through
    throwIfEEError(new FakeError("Oops", "validation"));
  });

  test("null/undefined error falls through", () => {
    throwIfEEError(null, [FakeError, STATUS_MAP]);
    throwIfEEError(undefined, [FakeError, STATUS_MAP]);
  });
});

// ---------------------------------------------------------------------------
// eeOnError tests
// ---------------------------------------------------------------------------

describe("eeOnError", () => {
  function createApp() {
    const app = new Hono();
    app.onError(eeOnError);
    return app;
  }

  test("surfaces HTTPException with res as-is", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new HTTPException(403, {
        res: Response.json({ error: "enterprise_required", message: "License required" }, { status: 403 }),
      });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("enterprise_required");
  });

  test("maps framework 400 to bad_request JSON", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new HTTPException(400);
    });
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("Invalid JSON body.");
  });

  test("re-throws unknown errors", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new Error("unexpected");
    });
    // Hono propagates re-thrown errors from onError
    try {
      await app.request("/test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("unexpected");
    }
  });
});
