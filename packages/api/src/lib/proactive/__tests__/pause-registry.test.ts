/**
 * Unit tests for the pure precedence resolver inside PauseRegistry
 * (#2295). The DB-backed paths get their own integration test in
 * `migrate-pg.test.ts` once `TEST_DATABASE_URL` is set.
 */
import { describe, expect, it } from "bun:test";
import {
  decidePauseFromRows,
  type PauseRow,
} from "@atlas/api/lib/proactive/pause-registry";

const NOW = 1_000_000_000_000;
const SOON = NOW + 60_000; // 1 min from "now"
const PAST = NOW - 60_000; // 1 min before "now"

function row(overrides: Partial<PauseRow>): PauseRow {
  return {
    id: overrides.id ?? "row_1",
    workspaceId: overrides.workspaceId ?? "ws_1",
    channelId: overrides.channelId ?? null,
    userId: overrides.userId ?? null,
    layer: overrides.layer ?? "channel-24h",
    expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
  };
}

describe("decidePauseFromRows", () => {
  it("returns paused=false when no rows match", () => {
    expect(decidePauseFromRows([], NOW)).toEqual({ paused: false });
  });

  it("paused with layer when a single non-expired row matches", () => {
    const decision = decidePauseFromRows(
      [row({ layer: "admin-channel", channelId: "C1", expiresAt: null })],
      NOW,
    );
    expect(decision).toEqual({ paused: true, layer: "admin-channel" });
  });

  it("paused includes `until` when the winning row has an expiry", () => {
    const decision = decidePauseFromRows(
      [row({ layer: "channel-24h", channelId: "C1", expiresAt: SOON })],
      NOW,
    );
    expect(decision).toEqual({
      paused: true,
      layer: "channel-24h",
      until: SOON,
    });
  });

  it("ignores rows whose expires_at is in the past", () => {
    const decision = decidePauseFromRows(
      [row({ layer: "channel-24h", channelId: "C1", expiresAt: PAST })],
      NOW,
    );
    expect(decision).toEqual({ paused: false });
  });

  it("ignores rows whose expires_at exactly equals now", () => {
    const decision = decidePauseFromRows(
      [row({ layer: "channel-24h", channelId: "C1", expiresAt: NOW })],
      NOW,
    );
    expect(decision).toEqual({ paused: false });
  });

  it("workspace-kill outranks admin-channel", () => {
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "admin-channel", channelId: "C1", expiresAt: null }),
        row({ id: "b", layer: "workspace-kill", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision.layer).toBe("workspace-kill");
  });

  it("admin-channel outranks user-optout", () => {
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "user-optout", userId: "U1", expiresAt: null }),
        row({ id: "b", layer: "admin-channel", channelId: "C1", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision.layer).toBe("admin-channel");
  });

  it("user-optout outranks channel-24h", () => {
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "channel-24h", channelId: "C1", expiresAt: SOON }),
        row({ id: "b", layer: "user-optout", userId: "U1", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision.layer).toBe("user-optout");
  });

  it("channel-24h wins when it's the only non-expired row", () => {
    const decision = decidePauseFromRows(
      [row({ layer: "channel-24h", channelId: "C1", expiresAt: SOON })],
      NOW,
    );
    expect(decision.layer).toBe("channel-24h");
  });

  it("all four layers active simultaneously → workspace-kill wins", () => {
    // Cartesian-conflict regression: the pairwise tests above prove
    // each adjacent precedence pair, but the listener actually feeds
    // the resolver the full candidate set returned from PG. This case
    // pins the documented `workspace-kill > admin-channel > user-optout
    // > channel-24h` chain in one shot so a future refactor that re-
    // orders `LAYER_PRIORITY` can't pass the pairwise tests yet break
    // the multi-layer conflict in production.
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "channel-24h", channelId: "C1", expiresAt: SOON }),
        row({ id: "b", layer: "user-optout", userId: "U1", expiresAt: null }),
        row({ id: "c", layer: "admin-channel", channelId: "C1", expiresAt: null }),
        row({ id: "d", layer: "workspace-kill", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision.paused).toBe(true);
    expect(decision.layer).toBe("workspace-kill");
  });

  it("workspace-kill still wins when expired admin-channel + active channel-24h are mixed", () => {
    // An expired admin-channel row is ignored entirely (priority does
    // not save it), but an active workspace-kill should still win over
    // the live channel-24h underneath.
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "admin-channel", channelId: "C1", expiresAt: PAST }),
        row({ id: "b", layer: "channel-24h", channelId: "C1", expiresAt: SOON }),
        row({ id: "c", layer: "workspace-kill", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision.layer).toBe("workspace-kill");
  });

  it("returns paused=false when every candidate is expired", () => {
    const decision = decidePauseFromRows(
      [
        row({ layer: "workspace-kill", expiresAt: PAST }),
        row({ layer: "channel-24h", channelId: "C1", expiresAt: PAST }),
      ],
      NOW,
    );
    expect(decision).toEqual({ paused: false });
  });

  it("omits `until` for indefinite winners even when other rows have expiry", () => {
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "channel-24h", channelId: "C1", expiresAt: SOON }),
        row({ id: "b", layer: "workspace-kill", expiresAt: null }),
      ],
      NOW,
    );
    expect(decision).toEqual({
      paused: true,
      layer: "workspace-kill",
      // `until` intentionally absent — workspace-kill is indefinite.
    });
    expect("until" in decision).toBe(false);
  });

  it("breaks ties on priority only — first row wins among equal layers", () => {
    // Two rows with the same priority — deterministic order is fine,
    // but exercise both to make sure we never throw.
    const decision = decidePauseFromRows(
      [
        row({ id: "a", layer: "channel-24h", channelId: "C1", expiresAt: SOON }),
        row({ id: "b", layer: "channel-24h", channelId: "C1", expiresAt: SOON + 1000 }),
      ],
      NOW,
    );
    expect(decision.paused).toBe(true);
    expect(decision.layer).toBe("channel-24h");
  });
});
