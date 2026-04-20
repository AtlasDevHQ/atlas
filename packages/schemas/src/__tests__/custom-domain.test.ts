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
    // `verified` needs the `verifiedAt` stamp per the #1661 invariant; the
    // other two tests use the pending-state base row.
    for (const status of ["pending", "failed"] as const) {
      expect(CustomDomainSchema.parse({ ...validDomain, status }).status).toBe(status);
    }
    expect(CustomDomainSchema.parse(verifiedDomain).status).toBe("verified");
  });

  test("all CERTIFICATE_STATUSES values parse", () => {
    for (const certificateStatus of ["PENDING", "ISSUED", "FAILED"] as const) {
      expect(
        CustomDomainSchema.parse({ ...validDomain, certificateStatus }).certificateStatus,
      ).toBe(certificateStatus);
    }
  });

  test("all DOMAIN_VERIFICATION_STATUSES values parse", () => {
    // `verified` must agree with `domainVerified=true` + `domainVerifiedAt`
    // set per the #1661 invariant — use `verifiedDomain` for that case.
    for (const domainVerificationStatus of ["pending", "failed"] as const) {
      expect(
        CustomDomainSchema.parse({ ...validDomain, domainVerificationStatus })
          .domainVerificationStatus,
      ).toBe(domainVerificationStatus);
    }
    expect(CustomDomainSchema.parse(verifiedDomain).domainVerificationStatus).toBe("verified");
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

  test("CustomDomainSchema rejects empty domain string", () => {
    const drifted = { ...validDomain, domain: "" };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant rejection — see #1661.
//
// DNS TXT verification writes `domain_verified`, `domain_verified_at`, and
// `domain_verification_status` atomically in `ee/src/platform/domains.ts`
// (see `verifyDomainDnsTxt`). The row-to-wire mapper defaults pre-migration
// rows to the all-unverified state. A row that shows `domainVerified=true`
// but `domainVerifiedAt=null` (or vice versa) is a bug somewhere upstream —
// either the DB or a partial hand-edit — and should fail parse at
// `useAdminFetch` time, not leak into the domain-detail UI as a silent
// mismatch.
//
// Railway CNAME/cert verification separately sets `status='verified'`
// together with `verified_at = now()` (same UPDATE statement in
// `verifyDomain`). A `verified` status without a `verifiedAt` stamp is
// drift.
// ---------------------------------------------------------------------------

describe("3-way verification invariant", () => {
  test("rejects domainVerified=true with domainVerifiedAt=null", () => {
    const drifted = {
      ...verifiedDomain,
      domainVerifiedAt: null,
    };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("rejects domainVerified=true with domainVerificationStatus!=='verified'", () => {
    const drifted = {
      ...verifiedDomain,
      domainVerificationStatus: "pending" as const,
    };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("rejects domainVerified=false with domainVerificationStatus='verified'", () => {
    const drifted = {
      ...validDomain,
      domainVerificationStatus: "verified" as const,
    };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });

  test("rejects status='verified' with verifiedAt=null", () => {
    const drifted = {
      ...verifiedDomain,
      verifiedAt: null,
    };
    expect(CustomDomainSchema.safeParse(drifted).success).toBe(false);
  });
});
