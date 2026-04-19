/**
 * Custom-domain wire-format schema.
 *
 * Single source of truth for custom-domain responses served by both the
 * admin surface (`/api/v1/admin/domain`) and the platform surface
 * (`/api/v1/platform/domains`). The route layer imports this for
 * OpenAPI response validation; the web layer imports it for
 * `useAdminFetch` response parsing. Before #1648, the route copies
 * used strict `z.enum(...)` on every status column while the web copy
 * silently relaxed `status` / `certificateStatus` to `z.string()` and
 * only kept `domainVerificationStatus` strict. The three enum columns
 * are the most drift-prone part of the shape — pinning them to the
 * tuples from `@useatlas/types` is the point of moving this schema
 * here.
 *
 * Tuples (`DOMAIN_STATUSES`, `CERTIFICATE_STATUSES`,
 * `DOMAIN_VERIFICATION_STATUSES`) come from `@useatlas/types` so adding
 * a new status to the TS union propagates here without a second edit.
 *
 * Uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field
 * rename in `@useatlas/types` breaks this file at compile time instead
 * of passing through to runtime.
 *
 * Strict `z.enum(TUPLE)` matches the `@hono/zod-openapi` extractor's
 * expectations — it cannot serialize `ZodCatch` wrappers (#1653) — and
 * keeps the generated OpenAPI spec describing the genuine output shape.
 */
import { z } from "zod";
import {
  DOMAIN_STATUSES,
  CERTIFICATE_STATUSES,
  DOMAIN_VERIFICATION_STATUSES,
  type CustomDomain,
} from "@useatlas/types";

const DomainStatusEnum = z.enum(DOMAIN_STATUSES);
const CertificateStatusEnum = z.enum(CERTIFICATE_STATUSES);
const DomainVerificationStatusEnum = z.enum(DOMAIN_VERIFICATION_STATUSES);

export const CustomDomainSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  domain: z.string(),
  status: DomainStatusEnum,
  railwayDomainId: z.string().nullable(),
  cnameTarget: z.string().nullable(),
  certificateStatus: CertificateStatusEnum.nullable(),
  verificationToken: z.string().nullable(),
  domainVerified: z.boolean(),
  domainVerifiedAt: z.string().nullable(),
  domainVerificationStatus: DomainVerificationStatusEnum,
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
}) satisfies z.ZodType<CustomDomain>;
