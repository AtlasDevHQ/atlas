/**
 * Tile state matrix for the backup-codes status tile. Asserts: no factors →
 * "required"; TOTP only → "ready"; passkey only → "not applicable"; both →
 * "ready" (TOTP is the source of truth for backup codes).
 */

import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";

import { BackupCodesStatus } from "../components/admin/security/backup-codes-status";

afterEach(() => {
  cleanup();
});

describe("BackupCodesStatus", () => {
  test("required state when neither factor enrolled", () => {
    render(<BackupCodesStatus totpEnabled={false} hasPasskey={false} />);
    expect(document.body.textContent).toContain("Required");
    expect(document.body.textContent).toContain("set up the authenticator app first");
  });

  test("not-applicable state when only a passkey is enrolled", () => {
    render(<BackupCodesStatus totpEnabled={false} hasPasskey={true} />);
    expect(document.body.textContent).toContain("Not applicable");
    expect(document.body.textContent).toContain("recover by enrolling a second passkey");
  });

  test("ready state when TOTP is enrolled (no passkey)", () => {
    render(<BackupCodesStatus totpEnabled={true} hasPasskey={false} />);
    expect(document.body.textContent).toContain("Backup codes ready");
    expect(document.body.textContent).toContain("Regenerate from the Authenticator tile");
  });

  test("ready state when both factors are enrolled (TOTP wins)", () => {
    render(<BackupCodesStatus totpEnabled={true} hasPasskey={true} />);
    expect(document.body.textContent).toContain("Backup codes ready");
    expect(document.body.textContent).not.toContain("Not applicable");
    expect(document.body.textContent).not.toContain("Required");
  });
});
