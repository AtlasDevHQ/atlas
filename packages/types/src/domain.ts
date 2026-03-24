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
// Custom domain record
// ---------------------------------------------------------------------------

export interface CustomDomain {
  id: string;
  workspaceId: string;
  domain: string;
  status: DomainStatus;
  /** Railway domain ID — used for Railway API calls. */
  railwayDomainId: string | null;
  /** CNAME target from Railway (e.g. *.up.railway.app). */
  cnameTarget: string | null;
  /** Current certificate status from Railway. */
  certificateStatus: CertificateStatus | null;
  createdAt: string;
  verifiedAt: string | null;
}
