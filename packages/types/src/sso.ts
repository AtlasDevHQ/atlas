/**
 * Enterprise SSO types shared across API, frontend, and SDK.
 *
 * SSO providers are org-scoped: each organization can register one or more
 * SAML/OIDC identity providers for single sign-on. Domain-based
 * auto-provisioning maps email domains to organizations.
 */

// ── Provider types ──────────────────────────────────────────────────

export const SSO_PROVIDER_TYPES = ["saml", "oidc"] as const;
export type SSOProviderType = (typeof SSO_PROVIDER_TYPES)[number];

/** SAML-specific configuration stored in sso_providers.config JSONB. */
export interface SSOSamlConfig {
  /** IdP Entity ID (issuer). */
  idpEntityId: string;
  /** IdP Single Sign-On URL (HTTP-Redirect or HTTP-POST binding). */
  idpSsoUrl: string;
  /** IdP X.509 certificate in PEM format for signature verification. */
  idpCertificate: string;
  /** SP Entity ID. Must be configured explicitly when initiating SAML flows. */
  spEntityId?: string;
  /** SP Assertion Consumer Service URL. */
  spAcsUrl?: string;
}

/** OIDC-specific configuration stored in sso_providers.config JSONB. */
export interface SSOOidcConfig {
  /** OAuth2 Client ID. */
  clientId: string;
  /** OAuth2 Client Secret (encrypted at rest in the sso_providers.config column). */
  clientSecret: string;
  /** OpenID Connect Discovery URL (e.g. `https://idp.example.com/.well-known/openid-configuration`). */
  discoveryUrl: string;
}

// ── Provider record (discriminated union) ───────────────────────────

interface SSOProviderBase {
  id: string;
  orgId: string;
  /** IdP issuer identifier (entityId for SAML, issuer URL for OIDC). */
  issuer: string;
  /** Email domain for auto-provisioning (e.g. "acme.com"). */
  domain: string;
  enabled: boolean;
  /** When true, password login is blocked for this org — users must use SSO. */
  ssoEnforced: boolean;
  createdAt: string;
  updatedAt: string;
  /** DNS TXT verification token (e.g. "atlas-verify=<uuid>"). */
  verificationToken: string | null;
  /** Whether domain ownership has been verified via DNS TXT record. */
  domainVerified: boolean;
  /** Timestamp when domain was verified, or null if not yet verified. */
  domainVerifiedAt: string | null;
  /** Domain verification status — constrained by database CHECK constraint. */
  domainVerificationStatus: "pending" | "verified" | "failed";
}

export interface SSOSamlProvider extends SSOProviderBase {
  type: "saml";
  config: SSOSamlConfig;
}

export interface SSOOidcProvider extends SSOProviderBase {
  type: "oidc";
  config: SSOOidcConfig;
}

/** Discriminated union — `type` determines the shape of `config`. */
export type SSOProvider = SSOSamlProvider | SSOOidcProvider;

// ── Request / response shapes ───────────────────────────────────────

export type CreateSSOProviderRequest =
  | { type: "saml"; issuer: string; domain: string; enabled?: boolean; config: SSOSamlConfig }
  | { type: "oidc"; issuer: string; domain: string; enabled?: boolean; config: SSOOidcConfig };

export interface UpdateSSOProviderRequest {
  issuer?: string;
  domain?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Response shape for list endpoints. Currently total equals providers.length (no pagination yet). */
export interface SSOProviderListResponse {
  providers: SSOProvider[];
  total: number;
}
