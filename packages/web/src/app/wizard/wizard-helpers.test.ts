import { describe, expect, it } from "bun:test";
import type { ConnectionInfo } from "@/ui/lib/types";
import {
  DEMO_CONNECTION_ID,
  connectionDisplayName,
  partitionConnections,
  userMessageFor,
} from "./wizard-helpers";

const conn = (id: string, extras: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  id,
  dbType: "postgres",
  ...extras,
});

describe("wizard-helpers", () => {
  describe("userMessageFor", () => {
    it("recognizes TypeError as a network failure", () => {
      expect(userMessageFor(new TypeError("Failed to fetch"), "fallback")).toMatch(
        /couldn't reach the server/i,
      );
    });

    it("recognizes filesystem permission errors and hides the path", () => {
      const result = userMessageFor(
        new Error("EACCES: permission denied, mkdir '/srv/atlas/semantic/.orgs'"),
        "fallback",
      );
      expect(result).toMatch(/semantic layer directory/i);
      expect(result).not.toContain("/srv/atlas/semantic/.orgs");
    });

    it("recognizes ENOENT", () => {
      expect(userMessageFor(new Error("ENOENT: no such file"), "fallback")).toMatch(
        /semantic layer directory/i,
      );
    });

    it("recognizes timeouts", () => {
      expect(userMessageFor(new Error("Request timed out after 30s"), "fallback")).toMatch(
        /took too long/i,
      );
    });

    it("preserves not-found errors verbatim (the message is already user-friendly)", () => {
      expect(userMessageFor(new Error('Connection "default" not found'), "fallback")).toBe(
        'Connection "default" not found',
      );
    });

    it("falls back for unknown errors", () => {
      expect(userMessageFor(new Error("DB driver explosion"), "Save failed")).toBe("Save failed");
    });

    it("falls back for non-Error values", () => {
      expect(userMessageFor("oops", "default fallback")).toBe("default fallback");
      expect(userMessageFor(null, "default fallback")).toBe("default fallback");
    });
  });

  describe("connectionDisplayName", () => {
    it("renames the demo connection", () => {
      expect(connectionDisplayName(conn(DEMO_CONNECTION_ID))).toBe("Demo dataset");
    });

    it("passes other ids through unchanged", () => {
      expect(connectionDisplayName(conn("warehouse"))).toBe("warehouse");
    });
  });

  describe("partitionConnections", () => {
    it("returns empty buckets when input is null", () => {
      const result = partitionConnections(null);
      expect(result.connections).toHaveLength(0);
      expect(result.demo).toBeNull();
      expect(result.user).toHaveLength(0);
    });

    it("isolates the demo connection", () => {
      const all = [conn("default"), conn(DEMO_CONNECTION_ID), conn("warehouse")];
      const result = partitionConnections(all);
      expect(result.demo?.id).toBe(DEMO_CONNECTION_ID);
      expect(result.user.map((c) => c.id)).toEqual(["default", "warehouse"]);
    });

    it("filters underscore-prefixed and draft_test ids from the user list", () => {
      const all = [
        conn("default"),
        conn("_internal"),
        conn("draft_test"),
        conn("warehouse"),
      ];
      const result = partitionConnections(all);
      expect(result.user.map((c) => c.id)).toEqual(["default", "warehouse"]);
    });

    it("returns no demo when demo connection is absent", () => {
      const all = [conn("default"), conn("warehouse")];
      expect(partitionConnections(all).demo).toBeNull();
    });
  });
});
