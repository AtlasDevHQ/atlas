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
  /** SP Entity ID. Defaults to `{BETTER_AUTH_URL}/api/auth/sso/saml/metadata`. */
  spEntityId?: string;
  /** SP Assertion Consumer Service URL. */
  spAcsUrl?: string;
}

/** OIDC-specific configuration stored in sso_providers.config JSONB. */
export interface SSOOidcConfig {
  /** OAuth2 Client ID. */
  clientId: string;
  /** OAuth2 Client Secret (encrypted at rest via encryptUrl). */
  clientSecret: string;
  /** OpenID Connect Discovery URL (e.g. `https://idp.example.com/.well-known/openid-configuration`). */
  discoveryUrl: string;
}

// ── Provider record ─────────────────────────────────────────────────

export interface SSOProvider {
  id: string;
  orgId: string;
  type: SSOProviderType;
  /** IdP issuer identifier (entityId for SAML, issuer URL for OIDC). */
  issuer: string;
  /** Email domain for auto-provisioning (e.g. "acme.com"). */
  domain: string;
  enabled: boolean;
  /** Provider-specific configuration (SAML or OIDC). */
  config: SSOSamlConfig | SSOOidcConfig;
  createdAt: string;
  updatedAt: string;
}

// ── Request / response shapes ───────────────────────────────────────

export interface CreateSSOProviderRequest {
  type: SSOProviderType;
  issuer: string;
  domain: string;
  enabled?: boolean;
  config: SSOSamlConfig | SSOOidcConfig;
}

export interface UpdateSSOProviderRequest {
  issuer?: string;
  domain?: string;
  enabled?: boolean;
  config?: Partial<SSOSamlConfig> | Partial<SSOOidcConfig>;
}

/** Response shape for list endpoints. */
export interface SSOProviderListResponse {
  providers: SSOProvider[];
  total: number;
}
