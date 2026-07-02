/**
 * Tests for the PlatformInstallationStore seam — the single home of the
 * five-op contract + the three shared invariants (org-hijack rejection,
 * decrypt-or-hide-row, env fallback) that the Slack and Discord stores
 * delegate to. Exercised with an in-memory fake backend so the
 * invariants are pinned once, independent of either real backend's SQL.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { InstallationBackend } from "../platform-installation-store";

let mockHasDB = true;
// The seam's only value-import from db/internal is `hasInternalDB`, but
// we mock the three exports the sibling store tests use so this file is
// safe if ever run in the same process as them (mock.module is
// process-global) and matches the repo's mock-all-exports convention.
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock(() => Promise.resolve([])),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const { PlatformInstallationStore, decryptOrHide } = await import(
  "../platform-installation-store"
);

// --- Fake backend ------------------------------------------------------

interface FakeFull {
  readonly org_id: string | null;
  readonly routing_id: string;
  readonly secret: string;
}
type FakePublic = Omit<FakeFull, "secret">;
interface FakeSaveInput {
  orgId?: string;
  secret: string;
}

const noopLog = { warn: () => {}, error: () => {} };

/** A logger that records every `warn`/`error` call for assertions. */
function makeSpyLog() {
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warns,
    errors,
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) => errors.push({ obj, msg }),
    },
  };
}

/** A backend whose behavior each test tweaks via the returned handles. */
function makeBackend(overrides: Partial<InstallationBackend<FakeFull, FakePublic, FakeSaveInput>> = {}) {
  const calls: string[] = [];
  const backend: InstallationBackend<FakeFull, FakePublic, FakeSaveInput> = {
    name: "Fake",
    routingNoun: "Fake workspace",
    deleteRequiresInternalDb: false,
    selectByRouting: async (id) => {
      calls.push(`selectByRouting:${id}`);
      return { org_id: "org-1", routing_id: id, secret: "s3cr3t" };
    },
    selectByOrg: async (orgId) => {
      calls.push(`selectByOrg:${orgId}`);
      return { org_id: orgId, routing_id: "r-1", secret: "s3cr3t" };
    },
    upsert: async (id) => {
      calls.push(`upsert:${id}`);
      return true;
    },
    deleteByRouting: async (id) => {
      calls.push(`deleteByRouting:${id}`);
    },
    deleteByOrg: async (orgId) => {
      calls.push(`deleteByOrg:${orgId}`);
      return true;
    },
    envFallback: (id) => {
      calls.push(`envFallback:${id}`);
      return { org_id: null, routing_id: id, secret: "env" };
    },
    toPublic: (full) => {
      const { secret: _drop, ...pub } = full;
      return pub;
    },
    ...overrides,
  };
  return { backend, calls };
}

beforeEach(() => {
  mockHasDB = true;
});

describe("PlatformInstallationStore", () => {
  describe("save — org-hijack invariant (seam-level: pinned once with a fake backend)", () => {
    it("rejects with a uniform error and logs the hijack attempt when the upsert matched no row", async () => {
      const { backend } = makeBackend({ upsert: async () => false });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.save("T123", { secret: "x" })).rejects.toThrow(
        "Fake workspace T123 is already bound to a different organization. Disconnect the existing installation first.",
      );
      // The rejection is auditable (security event) but not error-level.
      expect(spy.warns).toHaveLength(1);
      expect(spy.warns[0].obj).toEqual({ routingId: "T123" });
      expect(spy.errors).toHaveLength(0);
    });

    it("resolves when the upsert wrote a row", async () => {
      const upsertedIds: string[] = [];
      const { backend } = makeBackend({
        upsert: async (id) => {
          upsertedIds.push(id);
          return true;
        },
      });
      const store = new PlatformInstallationStore(backend, noopLog);

      await expect(store.save("T123", { secret: "x" })).resolves.toBeUndefined();
      expect(upsertedIds).toEqual(["T123"]);
    });

    it("throws (no upsert attempt) when no internal DB", async () => {
      mockHasDB = false;
      const { backend, calls } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      await expect(store.save("T123", { secret: "x" })).rejects.toThrow(
        "Cannot save Fake installation — no internal database configured",
      );
      expect(calls).toEqual([]);
    });

    it("logs and rethrows a backend DB error without masking it as a hijack", async () => {
      const boom = new Error("disk full");
      const { backend } = makeBackend({
        upsert: async () => {
          throw boom;
        },
      });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.save("T123", { secret: "x" })).rejects.toThrow("disk full");
      // A DB fault is error-logged (not the warn-level hijack path) and
      // never rendered as "already bound to a different organization".
      expect(spy.errors).toHaveLength(1);
      expect(spy.errors[0].obj).toEqual({ routingId: "T123", err: "disk full" });
      expect(spy.warns).toHaveLength(0);
    });
  });

  describe("get — env fallback vs DB", () => {
    it("reads the backend when an internal DB is present", async () => {
      const { backend, calls } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      const result = await store.get("T123");
      expect(result).toEqual({ org_id: "org-1", routing_id: "T123", secret: "s3cr3t" });
      expect(calls).toEqual(["selectByRouting:T123"]);
    });

    it("falls back to the env record when no internal DB (never queries)", async () => {
      mockHasDB = false;
      const { backend, calls } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      const result = await store.get("T123");
      expect(result).toEqual({ org_id: null, routing_id: "T123", secret: "env" });
      expect(calls).toEqual(["envFallback:T123"]);
    });

    it("logs and rethrows a DB error — never falls through to env", async () => {
      const { backend } = makeBackend({
        selectByRouting: async () => {
          throw new Error("connection refused");
        },
      });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.get("T123")).rejects.toThrow("connection refused");
      expect(spy.errors).toHaveLength(1);
      expect(spy.errors[0].obj).toEqual({ routingId: "T123", err: "connection refused" });
    });
  });

  describe("getByOrg — strip secret + no-DB gate", () => {
    it("returns the secret-stripped public shape", async () => {
      const { backend } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      const result = await store.getByOrg("org-1");
      expect(result).toEqual({ org_id: "org-1", routing_id: "r-1" });
      expect((result as Record<string, unknown>).secret).toBeUndefined();
    });

    it("returns null (no query) when no internal DB", async () => {
      mockHasDB = false;
      const { backend, calls } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      expect(await store.getByOrg("org-1")).toBeNull();
      expect(calls).toEqual([]);
    });

    it("returns null when the backend hides the row", async () => {
      const { backend } = makeBackend({ selectByOrg: async () => null });
      const store = new PlatformInstallationStore(backend, noopLog);

      expect(await store.getByOrg("org-1")).toBeNull();
    });

    it("logs and rethrows a DB error", async () => {
      const { backend } = makeBackend({
        selectByOrg: async () => {
          throw new Error("timeout");
        },
      });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.getByOrg("org-1")).rejects.toThrow("timeout");
      expect(spy.errors).toHaveLength(1);
      expect(spy.errors[0].obj).toEqual({ orgId: "org-1", err: "timeout" });
    });
  });

  describe("delete — per-backend no-DB policy", () => {
    it("calls deleteByRouting when a DB is present", async () => {
      const { backend, calls } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);

      await expect(store.delete("T123")).resolves.toBeUndefined();
      expect(calls).toEqual(["deleteByRouting:T123"]);
    });

    it("logs and rethrows when deleteByRouting throws", async () => {
      const { backend } = makeBackend({
        deleteByRouting: async () => {
          throw new Error("lock timeout");
        },
      });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.delete("T123")).rejects.toThrow("lock timeout");
      expect(spy.errors).toHaveLength(1);
      expect(spy.errors[0].obj).toEqual({ routingId: "T123", err: "lock timeout" });
    });

    it("warns and no-ops without a DB when deleteRequiresInternalDb is false", async () => {
      mockHasDB = false;
      let warned = false;
      const { backend, calls } = makeBackend({ deleteRequiresInternalDb: false });
      const store = new PlatformInstallationStore(backend, {
        warn: () => {
          warned = true;
        },
        error: () => {},
      });

      await expect(store.delete("T123")).resolves.toBeUndefined();
      expect(warned).toBe(true);
      expect(calls).toEqual([]);
    });

    it("throws without a DB when deleteRequiresInternalDb is true", async () => {
      mockHasDB = false;
      const { backend } = makeBackend({ deleteRequiresInternalDb: true });
      const store = new PlatformInstallationStore(backend, noopLog);

      await expect(store.delete("T123")).rejects.toThrow(
        "Cannot delete Fake installation — no internal database configured",
      );
    });
  });

  describe("deleteByOrg", () => {
    it("returns the backend boolean when a DB is present", async () => {
      const { backend } = makeBackend({ deleteByOrg: async () => false });
      const store = new PlatformInstallationStore(backend, noopLog);
      expect(await store.deleteByOrg("org-1")).toBe(false);
    });

    it("throws when no internal DB", async () => {
      mockHasDB = false;
      const { backend } = makeBackend();
      const store = new PlatformInstallationStore(backend, noopLog);
      await expect(store.deleteByOrg("org-1")).rejects.toThrow(
        "no internal database configured",
      );
    });

    it("logs and rethrows a DB error", async () => {
      const { backend } = makeBackend({
        deleteByOrg: async () => {
          throw new Error("connection lost");
        },
      });
      const spy = makeSpyLog();
      const store = new PlatformInstallationStore(backend, spy.log);

      await expect(store.deleteByOrg("org-1")).rejects.toThrow("connection lost");
      expect(spy.errors).toHaveLength(1);
      expect(spy.errors[0].obj).toEqual({ orgId: "org-1", err: "connection lost" });
    });
  });
});

describe("decryptOrHide", () => {
  it("returns { ok: true, value } on success", () => {
    const result = decryptOrHide("blob", (c) => `plain:${c}`, () => {});
    expect(result).toEqual({ ok: true, value: "plain:blob" });
  });

  it("returns { ok: false } and reports the message on failure", () => {
    let reported = "";
    const result = decryptOrHide(
      "blob",
      () => {
        throw new Error("auth tag mismatch");
      },
      (msg) => {
        reported = msg;
      },
    );
    expect(result).toEqual({ ok: false });
    expect(reported).toBe("auth tag mismatch");
  });

  it("stringifies a non-Error throw", () => {
    let reported = "";
    const result = decryptOrHide(
      "blob",
      () => {
        throw "raw string failure";
      },
      (msg) => {
        reported = msg;
      },
    );
    expect(result).toEqual({ ok: false });
    expect(reported).toBe("raw string failure");
  });
});
