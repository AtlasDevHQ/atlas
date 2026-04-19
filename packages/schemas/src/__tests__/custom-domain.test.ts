import { describe, expect, test } from "bun:test";
import { CustomDomainSchema } from "../custom-domain";

const validDomain = {
  id: "dom_1",
  workspaceId: "org_1",
  domain: "data.acme.com",
  status: "pending" as const,
  railwayDomainId: "rw_abc",
  cnameTarget: "abc123.up.railway.app",
  certificateStatus: "PENDING" as const,
  verificationToken: "atlas-verify=uuid-xyz",
  domainVerified: false,
  domainVerifiedAt: null,
  domainVerificationStatus: "pending" as const,
  createdAt: "2026-04-19T12:00:00.000Z",
  verifiedAt: null,
};

const verifiedDomain = {
  ...validDomain,
  id: "dom_2",
  status: "verified" as const,
  certificateStatus: "ISSUED" as const,
  domainVerified: true,
  domainVerifiedAt: "2026-04-19T12:30:00.000Z",
  domainVerificationStatus: "verified" as const,
  verifiedAt: "2026-04-19T12:30:00.000Z",
};

describe("happy-path parses", () => {
  test("CustomDomainSchema parses a pending domain", () => {
    expect(CustomDomainSchema.parse(validDomain)).toEqual(validDomain);
  });

  test("CustomDomainSchema parses a fully verified domain", () => {
    expect(CustomDomainSchema.parse(verifiedDomain)).toEqual(verifiedDomain);
  });

  test("CustomDomainSchema permits null certificateStatus (pre-Railway row)", () => {
    const nullCert = { ...validDomain, certificateStatus: null };
    expect(CustomDomainSchema.parse(nullCert).certificateStatus).toBeNull();
  });

  test("CustomDomainSchema permits null railwayDomainId / cnameTarget / verificationToken (pre-migration row)", () => {
    const preMigration = {
      ...validDomain,
      railwayDomainId: null,
      cnameTarget: null,
      verificationToken: null,
    };
    const parsed = CustomDomainSchema.parse(preMigration);
    expect(parsed.railwayDomainId).toBeNull();
    expect(parsed.cnameTarget).toBeNull();
    expect(parsed.verificationToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — three enum columns, three drift traps.
//
// Web previously relaxed `status` and `certificateStatus` to z.string() —
// `domainVerificationStatus` was already strict, which is what this
// migration generalizes. A drifted Railway status (e.g. new "REVOKED"
// cert state) now fails parse at `useAdminFetch` time and surfaces a
// `schema_mismatch` banner instead of leaking through as untyped text
// into the domain-detail UI.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown status fails parse", () => {
    const drifted = { ...validDomain, status: "propagating" };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown certificateStatus fails parse", () => {
    const drifted = { ...validDomain, certificateStatus: "REVOKED" };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown domainVerificationStatus fails parse", () => {
    const drifted = { ...validDomain, domainVerificationStatus: "unknown" };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("all DOMAIN_STATUSES values parse", () => {
    for (const status of ["pending", "verified", "failed"] as const) {
      expect(CustomDomainSchema.parse({ ...validDomain, status }).status).toBe(status);
    }
  });

  test("all CERTIFICATE_STATUSES values parse", () => {
    for (const certificateStatus of ["PENDING", "ISSUED", "FAILED"] as const) {
      expect(
        CustomDomainSchema.parse({ ...validDomain, certificateStatus }).certificateStatus,
      ).toBe(certificateStatus);
    }
  });

  test("all DOMAIN_VERIFICATION_STATUSES values parse", () => {
    for (const domainVerificationStatus of ["pending", "verified", "failed"] as const) {
      expect(
        CustomDomainSchema.parse({ ...validDomain, domainVerificationStatus })
          .domainVerificationStatus,
      ).toBe(domainVerificationStatus);
    }
  });
});

describe("structural rejection", () => {
  test("CustomDomainSchema rejects missing workspaceId", () => {
    const { workspaceId: _wid, ...missing } = validDomain;
    expect(CustomDomainSchema.safeParse(missing).success).toBe(false);
  });

  test("CustomDomainSchema rejects non-boolean domainVerified", () => {
    const drifted = { ...validDomain, domainVerified: "true" };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("CustomDomainSchema rejects missing domainVerificationStatus", () => {
    const { domainVerificationStatus: _dvs, ...missing } = validDomain;
    expect(CustomDomainSchema.safeParse(missing).success).toBe(false);
  });
});
