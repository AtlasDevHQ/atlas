/**
 * Unit tests for the ops-smoke-crm arg parser, wipe gate, and the outbox
 * polling helper. Live-network phases (Twenty list + wipe) are NOT
 * exercised here — those depend on the Twenty client extensions landing
 * in a parallel PR. The smoke command's other phases (parse, gate, poll)
 * are fully covered.
 */
import { describe, expect, test } from "bun:test";

import {
  checkSmokeWipeGate,
  parseSmokeCrmArgs,
  pollOutboxUntilDrained,
  SMOKE_EXIT,
  type SmokeCrmDB,
} from "../commands/operator/ops-smoke-crm";
import { createTwentyAdmin } from "../../lib/smoke-crm/twenty-admin";

// ─────────────────────────────────────────────────────────────────────
//  parseSmokeCrmArgs
// ─────────────────────────────────────────────────────────────────────

describe("parseSmokeCrmArgs — required fields", () => {
  test("rejects missing --personas", () => {
    const r = parseSmokeCrmArgs(["ops", "smoke-crm"], {
      TWENTY_API_KEY: "k",
      DATABASE_URL: "postgresql://x/y",
    } as NodeJS.ProcessEnv);
    expect("error" in r && r.error).toMatch(/--personas/);
  });

  test("rejects missing Twenty API key (no flag, no env)", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml"],
      { DATABASE_URL: "postgresql://x/y" } as NodeJS.ProcessEnv,
    );
    expect("error" in r && r.error).toMatch(/--twenty-api-key.*TWENTY_API_KEY/);
  });

  test("rejects missing tenant DB URL", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml"],
      { TWENTY_API_KEY: "k" } as NodeJS.ProcessEnv,
    );
    expect("error" in r && r.error).toMatch(/--database-url.*ATLAS_TEAM_PG_URL.*DATABASE_URL/);
  });

  test("rejects non-numeric --timeout-seconds", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml", "--timeout-seconds", "abc"],
      { TWENTY_API_KEY: "k", DATABASE_URL: "postgresql://x/y" } as NodeJS.ProcessEnv,
    );
    expect("error" in r && r.error).toMatch(/--timeout-seconds.*positive integer/);
  });
});

describe("parseSmokeCrmArgs — happy path + defaults", () => {
  test("--twenty-base-url defaults to api.twenty.com", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml"],
      { TWENTY_API_KEY: "k", DATABASE_URL: "postgresql://x/y" } as NodeJS.ProcessEnv,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.twentyBaseUrl).toBe("https://api.twenty.com");
    expect(r.timeoutSeconds).toBe(60);
    expect(r.wipeTwenty).toBe(false);
  });

  test("flag wins over env (precedence pinned — flag is operator's explicit override)", () => {
    const r = parseSmokeCrmArgs(
      [
        "ops",
        "smoke-crm",
        "--personas",
        "./f.yml",
        "--twenty-base-url",
        "https://crm.example.com",
        "--twenty-api-key",
        "flag-key",
        "--database-url",
        "postgresql://flag/db",
      ],
      {
        TWENTY_API_KEY: "env-key",
        TWENTY_BASE_URL: "https://env.twenty.com",
        ATLAS_TEAM_PG_URL: "postgresql://env/db",
      } as NodeJS.ProcessEnv,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.twentyBaseUrl).toBe("https://crm.example.com");
    expect(r.twentyApiKey).toBe("flag-key");
    expect(r.databaseUrl).toBe("postgresql://flag/db");
  });

  test("ATLAS_TEAM_PG_URL wins over DATABASE_URL", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml"],
      {
        TWENTY_API_KEY: "k",
        ATLAS_TEAM_PG_URL: "postgresql://team/db",
        DATABASE_URL: "postgresql://other/db",
      } as NodeJS.ProcessEnv,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.databaseUrl).toBe("postgresql://team/db");
  });

  test("--wipe-twenty toggles the flag", () => {
    const r = parseSmokeCrmArgs(
      ["ops", "smoke-crm", "--personas", "./f.yml", "--wipe-twenty"],
      { TWENTY_API_KEY: "k", DATABASE_URL: "postgresql://x/y" } as NodeJS.ProcessEnv,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.wipeTwenty).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  checkSmokeWipeGate
// ─────────────────────────────────────────────────────────────────────

describe("checkSmokeWipeGate", () => {
  test("returns null when --wipe-twenty is absent (gate doesn't apply)", () => {
    expect(checkSmokeWipeGate(["ops", "smoke-crm"], {} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("rejects --wipe-twenty without ATLAS_SMOKE_WIPE_OK", () => {
    expect(
      checkSmokeWipeGate(["ops", "smoke-crm", "--wipe-twenty"], {} as NodeJS.ProcessEnv),
    ).toContain("ATLAS_SMOKE_WIPE_OK=1");
  });

  test("rejects ATLAS_SMOKE_WIPE_OK with non-`1` value (parity with ops wipe rule)", () => {
    // Catch the shell-truthy footgun: `ATLAS_SMOKE_WIPE_OK=true` should NOT
    // cleared the gate. The literal "1" requirement keeps it explicit.
    expect(
      checkSmokeWipeGate(
        ["ops", "smoke-crm", "--wipe-twenty"],
        { ATLAS_SMOKE_WIPE_OK: "true" } as NodeJS.ProcessEnv,
      ),
    ).toContain("ATLAS_SMOKE_WIPE_OK=1");
  });

  test("clears when both gates are present", () => {
    expect(
      checkSmokeWipeGate(
        ["ops", "smoke-crm", "--wipe-twenty"],
        { ATLAS_SMOKE_WIPE_OK: "1" } as NodeJS.ProcessEnv,
      ),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  pollOutboxUntilDrained
// ─────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  status: "pending" | "in_flight" | "done" | "dead";
  last_error: string | null;
}

function makeFakeDb(states: ReadonlyArray<ReadonlyArray<FakeRow>>): SmokeCrmDB {
  let i = 0;
  return {
    async query<T extends Record<string, unknown>>() {
      const rows = states[Math.min(i, states.length - 1)];
      i++;
      return rows as unknown as T[];
    },
  };
}

describe("pollOutboxUntilDrained", () => {
  test("returns immediately when all ids are terminal on first poll", async () => {
    const db = makeFakeDb([
      [
        { id: "a", status: "done", last_error: null },
        { id: "b", status: "done", last_error: null },
      ],
    ]);
    const result = await pollOutboxUntilDrained(db, ["a", "b"], 5, async () => {
      throw new Error("sleep should not be called when first poll drains");
    });
    expect(result.timedOut).toBe(false);
    expect(result.statuses.get("a")).toBe("done");
    expect(result.deadErrors).toEqual([]);
  });

  test("collects per-id last_error when an id ends `dead`", async () => {
    const db = makeFakeDb([
      [
        { id: "a", status: "done", last_error: null },
        { id: "b", status: "dead", last_error: "twenty 503" },
      ],
    ]);
    const result = await pollOutboxUntilDrained(db, ["a", "b"], 5, async () => {});
    expect(result.timedOut).toBe(false);
    expect(result.deadErrors).toEqual([{ id: "b", error: "twenty 503" }]);
  });

  test("times out when ids stay pending past the deadline — clock-injected", async () => {
    // Inject `now` so the test runs in real-time microseconds rather than
    // depending on wall-clock pacing.
    const db = makeFakeDb([
      [{ id: "a", status: "pending", last_error: null }],
      [{ id: "a", status: "pending", last_error: null }],
      [{ id: "a", status: "pending", last_error: null }],
    ]);
    let virtualNow = 0;
    const result = await pollOutboxUntilDrained(
      db,
      ["a"],
      1, // 1 second budget
      async () => {
        virtualNow += 2_000; // jump past the deadline on each tick
      },
      () => virtualNow,
    );
    expect(result.timedOut).toBe(true);
    expect(result.statuses.get("a")).toBe("pending");
  });

  test("returns dead+done mixed when one row finishes successfully and one fails", async () => {
    const db = makeFakeDb([
      [
        { id: "a", status: "pending", last_error: null },
        { id: "b", status: "in_flight", last_error: null },
      ],
      [
        { id: "a", status: "done", last_error: null },
        { id: "b", status: "dead", last_error: "permanent: bad payload" },
      ],
    ]);
    const result = await pollOutboxUntilDrained(db, ["a", "b"], 5, async () => {});
    expect(result.timedOut).toBe(false);
    expect(result.statuses.get("a")).toBe("done");
    expect(result.statuses.get("b")).toBe("dead");
    expect(result.deadErrors).toEqual([
      { id: "b", error: "permanent: bad payload" },
    ]);
  });

  test("empty ids short-circuits — no DB call, returns immediately", async () => {
    // Defensive guard for any future code path that polls with an empty list
    // (e.g. `--dry-run` that skips enqueue). Without the early return the
    // for-loop trivially completes `allDone=true` on the first iteration, but
    // the DB query still fires — which would be a no-op against `WHERE id =
    // ANY('{}')` but wastes a roundtrip. Pin the short-circuit.
    let queried = false;
    const db: SmokeCrmDB = {
      async query() {
        queried = true;
        return [];
      },
    };
    const result = await pollOutboxUntilDrained(db, [], 5, async () => {
      throw new Error("sleep must not be called");
    });
    expect(queried).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.statuses.size).toBe(0);
    expect(result.missingFromDb).toEqual([]);
  });

  test("missingFromDb lists ids never seen in any poll response", async () => {
    // Simulates a row deleted out-of-band during the poll (admin TRUNCATE,
    // out-of-band cleanup, etc.). Without this, the timeout report would
    // silently omit the missing ids and the operator wouldn't know which row
    // to chase. Catches the silent-failure-hunter MEDIUM finding.
    const db = makeFakeDb([
      [
        { id: "a", status: "done", last_error: null },
        // "b" never appears in any response — was deleted before the poll.
      ],
    ]);
    const result = await pollOutboxUntilDrained(
      db,
      ["a", "b"],
      1,
      async () => {},
      (() => {
        let n = 0;
        return () => (n++ === 0 ? 0 : 999_999);
      })(),
    );
    expect(result.timedOut).toBe(true);
    expect(result.missingFromDb).toEqual(["b"]);
    expect(result.statuses.get("a")).toBe("done");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  TwentyAdmin — live adapter shape
//
//  The live admin delegates to `@useatlas/twenty/client` exports (per PR
//  #2867). Behaviour of those exports is tested in plugins/twenty/__tests__;
//  here we just confirm the factory returns something with the expected
//  method surface so a future signature drift surfaces as a type error.
// ─────────────────────────────────────────────────────────────────────

describe("createTwentyAdmin — adapter shape", () => {
  test("returns an admin object with every TwentyAdmin method", () => {
    const admin = createTwentyAdmin({
      baseUrl: "https://api.twenty.com",
      apiKey: "test-key",
    });
    expect(typeof admin.listAllPeople).toBe("function");
    expect(typeof admin.listAllNotes).toBe("function");
    expect(typeof admin.deletePerson).toBe("function");
    expect(typeof admin.deleteNote).toBe("function");
    expect(typeof admin.wipeWorkspace).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Exit code surface
// ─────────────────────────────────────────────────────────────────────

describe("SMOKE_EXIT", () => {
  test("exit codes are pinned for chained scripts", () => {
    // A change here is a contract break — any script grepping for code 3
    // on a diff dirty would silently start reporting clean.
    expect(SMOKE_EXIT.OK).toBe(0);
    expect(SMOKE_EXIT.USAGE).toBe(1);
    expect(SMOKE_EXIT.TIMEOUT).toBe(2);
    expect(SMOKE_EXIT.DIFF).toBe(3);
    expect(SMOKE_EXIT.WIPE_FAIL).toBe(4);
  });
});
