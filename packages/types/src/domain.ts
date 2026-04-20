/**
 * Custom domain types for enterprise workspace branding.
 *
 * Workspaces can register custom domains (e.g. data.customer.com)
 * that are provisioned via Railway's custom domain API. Railway
 * handles TLS certificates (Let's Encrypt) automatically. Atlas
 * stores the mapping from domain to workspace for host-based routing.
 */

// ---------------------------------------------------------------------------
// Domain status
// ---------------------------------------------------------------------------

export const DOMAIN_STATUSES = ["pending", "verified", "failed"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

// ---------------------------------------------------------------------------
// Certificate status (from Railway)
// ---------------------------------------------------------------------------

export const CERTIFICATE_STATUSES = ["PENDING", "ISSUED", "FAILED"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Domain verification status (DNS TXT ownership proof)
// ---------------------------------------------------------------------------

export const DOMAIN_VERIFICATION_STATUSES = ["pending", "verified", "failed"] as const;
export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Custom domain record
//
// Structural shape only — invariants (DNS TXT trio coupling, Railway
// status→verifiedAt implication, non-empty domain) are enforced at the
// wire boundary by `CustomDomainSchema` in `@useatlas/schemas`.
// Code-only constructors of `CustomDomain` bypass those invariants.
// ---------------------------------------------------------------------------

export interface CustomDomain {
  id: string;
  workspaceId: string;
  domain: string;
  /** Railway CNAME + TLS certificate verification status. */
  status: DomainStatus;
  /** Railway domain ID — used for Railway API calls. */
  railwayDomainId: string | null;
  /** CNAME target from Railway (e.g. abc123.up.railway.app). */
  cnameTarget: string | null;
  /** Current certificate status from Railway. */
  certificateStatus: CertificateStatus | null;
  /** DNS TXT verification token (atlas-verify=<uuid>). Null for pre-migration domains. */
  verificationToken: string | null;
  /** Whether domain ownership has been verified via DNS TXT. Derived from `domainVerificationStatus === "verified"` — exists for query convenience. */
  domainVerified: boolean;
  /** Timestamp of successful DNS TXT verification. */
  domainVerifiedAt: string | null;
  /** Current DNS TXT ownership verification status. Tracks independently from `status`, which reflects Railway CNAME/certificate verification. */
  domainVerificationStatus: DomainVerificationStatus;
  createdAt: string;
  verifiedAt: string | null;
}
