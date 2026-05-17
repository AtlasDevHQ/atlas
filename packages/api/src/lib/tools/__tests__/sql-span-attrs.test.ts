/**
 * Span-attribute builder tests (#2519, PRD #2515 slice 4).
 *
 * Verifies the pure helper that constructs OTel attributes for the
 * `atlas.sql.execute` span. The integration with the global tracer
 * provider is exercised end-to-end in `agent-cross-env-routing.test.ts`;
 * this file pins the attribute keys and the routing-mode default.
 */

import { describe, expect, it } from "bun:test";
import { buildSqlExecuteSpanAttrs } from "@atlas/api/lib/tools/sql";

describe("buildSqlExecuteSpanAttrs (#2519)", () => {
  it("emits the baseline keys with the default routing_mode", () => {
    const attrs = buildSqlExecuteSpanAttrs({
      dbType: "postgres",
      connectionId: "default",
    });
    expect(attrs).toEqual({
      "db.system": "postgres",
      "atlas.connection_id": "default",
      "atlas.routing_mode": "auto",
    });
  });

  it("stamps the supplied routing_mode for fanout legs", () => {
    const attrs = buildSqlExecuteSpanAttrs({
      dbType: "postgres",
      connectionId: "us-int",
      routingMode: "all",
    });
    expect(attrs["atlas.routing_mode"]).toBe("all");
  });

  it("includes atlas.connection_group_id when known", () => {
    const attrs = buildSqlExecuteSpanAttrs({
      dbType: "postgres",
      connectionId: "us-int",
      routingMode: "all",
      connectionGroupId: "prod",
    });
    expect(attrs["atlas.connection_group_id"]).toBe("prod");
  });

  it("omits atlas.connection_group_id when undefined (single-env path)", () => {
    const attrs = buildSqlExecuteSpanAttrs({
      dbType: "mysql",
      connectionId: "default",
      routingMode: "auto",
    });
    expect("atlas.connection_group_id" in attrs).toBe(false);
  });

  it("supports the `pin` routing mode for the picker pin override (slice 3)", () => {
    const attrs = buildSqlExecuteSpanAttrs({
      dbType: "postgres",
      connectionId: "eu",
      routingMode: "pin",
    });
    expect(attrs["atlas.routing_mode"]).toBe("pin");
  });
});
