import { z } from "zod";

// ── Shared schemas for SSO admin UI ──────────────────────────────

export const SSOProviderSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean(),
  ssoEnforced: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verificationToken: z.string().nullable(),
  domainVerified: z.boolean(),
  domainVerifiedAt: z.string().nullable(),
  domainVerificationStatus: z.enum(["pending", "verified", "failed"]),
});

export type SSOProviderSummary = z.infer<typeof SSOProviderSchema>;

export const ProvidersResponseSchema = z.object({
  providers: z.array(SSOProviderSchema),
  total: z.number(),
});

export const EnforcementResponseSchema = z.object({
  enforced: z.boolean(),
  orgId: z.string(),
});

/** Detail response includes full config (redacted secrets show as "REDACTED"). */
export const SSOProviderDetailSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean(),
  ssoEnforced: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  config: z.record(z.string(), z.unknown()),
  verificationToken: z.string().nullable(),
  domainVerified: z.boolean(),
  domainVerifiedAt: z.string().nullable(),
  domainVerificationStatus: z.enum(["pending", "verified", "failed"]),
});

export type SSOProviderDetail = z.infer<typeof SSOProviderDetailSchema>;

export const DomainCheckResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});

export const VerifyDomainResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});

// ── Form schemas ─────────────────────────────────────────────────

const PEM_PREFIX = "-----BEGIN CERTIFICATE-----";

export const samlFormSchema = z.object({
  type: z.literal("saml"),
  domain: z.string().min(1, "Domain is required").regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Enter a valid domain (e.g. acme.com)"),
  issuer: z.string().min(1, "Issuer URL is required").url("Enter a valid URL"),
  idpEntityId: z.string().min(1, "IdP Entity ID is required"),
  idpSsoUrl: z.string().min(1, "IdP SSO URL is required").url("Enter a valid URL"),
  idpCertificate: z.string().min(1, "Certificate is required").refine(
    (v) => v.trimStart().startsWith(PEM_PREFIX),
    "Certificate must be in PEM format (starts with -----BEGIN CERTIFICATE-----)",
  ),
});

export const oidcFormSchema = z.object({
  type: z.literal("oidc"),
  domain: z.string().min(1, "Domain is required").regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Enter a valid domain (e.g. acme.com)"),
  issuer: z.string().min(1, "Issuer URL is required").url("Enter a valid URL"),
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client Secret is required"),
  discoveryUrl: z.string().min(1, "Discovery URL is required").url("Enter a valid URL"),
});

export const createProviderSchema = z.discriminatedUnion("type", [samlFormSchema, oidcFormSchema]);
export type CreateProviderForm = z.infer<typeof createProviderSchema>;

/** Edit schemas: SAML is identical to create. OIDC makes clientSecret optional (blank = keep existing). */
export const editSamlFormSchema = samlFormSchema;
export const editOidcFormSchema = oidcFormSchema.extend({
  clientSecret: z.string().optional().default(""),
});
export const editProviderSchema = z.discriminatedUnion("type", [editSamlFormSchema, editOidcFormSchema]);
export type EditProviderForm = z.infer<typeof editProviderSchema>;

// ── Test result schemas ──────────────────────────────────────────

export const SSOTestResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("oidc"),
    success: z.boolean(),
    testedAt: z.string(),
    details: z.object({
      discoveryReachable: z.boolean(),
      issuerMatch: z.boolean(),
      requiredFieldsPresent: z.boolean(),
      endpoints: z.record(z.string(), z.string()),
    }),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("saml"),
    success: z.boolean(),
    testedAt: z.string(),
    details: z.object({
      certValid: z.boolean(),
      certSubject: z.string().nullable(),
      certExpiry: z.string().nullable(),
      certDaysRemaining: z.number().nullable(),
      idpReachable: z.boolean().nullable(),
    }),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }),
]);

export type SSOTestResult = z.infer<typeof SSOTestResultSchema>;
