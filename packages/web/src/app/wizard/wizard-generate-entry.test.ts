/**
 * The two onboarding doors (#3237) must launch the *same* generate flow — that
 * invariant is enforced by both building their href through `wizardGenerateHref`.
 * These tests pin the href shape and the empty-state connection-selection rule.
 */

import { describe, expect, it } from "bun:test";
import type { ConnectionInfo } from "@/ui/lib/types";
import { DEMO_CONNECTION_ID } from "../admin/connections/columns";
import {
  wizardGenerateHref,
  generateLaunchConnectionId,
} from "./wizard-generate-entry";

const conn = (id: string, extras: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  id,
  dbType: "postgres",
  ...extras,
});

describe("wizard-generate-entry", () => {
  describe("wizardGenerateHref", () => {
    it("deep-links to the table picker (step 2) when a connection is given", () => {
      expect(wizardGenerateHref("warehouse")).toBe(
        "/wizard?connectionId=warehouse&step=2",
      );
    });

    it("routes to the bare wizard (datasource picker) with no connection", () => {
      expect(wizardGenerateHref()).toBe("/wizard");
      expect(wizardGenerateHref(null)).toBe("/wizard");
      expect(wizardGenerateHref("")).toBe("/wizard");
    });

    it("URL-encodes the connection id", () => {
      // Connection ids are slug-validated, but encoding keeps the door honest
      // if that ever loosens — a raw `&`/space must not corrupt the query.
      expect(wizardGenerateHref("a b&step=9")).toBe(
        "/wizard?connectionId=a%20b%26step%3D9&step=2",
      );
    });
  });

  describe("generateLaunchConnectionId", () => {
    it("returns the sole real connection's id", () => {
      expect(generateLaunchConnectionId([conn("warehouse")])).toBe("warehouse");
    });

    it("returns null with zero connections (route to the picker)", () => {
      expect(generateLaunchConnectionId([])).toBeNull();
    });

    it("returns null with multiple connections (let the user choose)", () => {
      expect(generateLaunchConnectionId([conn("us-prod"), conn("eu-prod")])).toBeNull();
    });

    it("excludes the demo connection from the count", () => {
      // Demo + one real → deep-link to the real one.
      expect(
        generateLaunchConnectionId([conn(DEMO_CONNECTION_ID), conn("warehouse")]),
      ).toBe("warehouse");
      // Demo only → nothing of the user's to scope to.
      expect(generateLaunchConnectionId([conn(DEMO_CONNECTION_ID)])).toBeNull();
    });
  });
});
