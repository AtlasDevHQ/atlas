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
 *
 * The `superRefine()` at the bottom encodes two invariants that the server
 * enforces atomically but the structural schema alone can't express
 * (see #1661). `verifyDomainDnsTxt` writes `domain_verified`,
 * `domain_verified_at`, and `domain_verification_status` in one UPDATE,
 * and `verifyDomain` pairs `status='verified'` with `verified_at=now()`
 * in another. A half-reconciled row would parse cleanly against the
 * plain object shape and leak UI inconsistency; the refine turns it
 * into a `schema_mismatch` banner at `useAdminFetch` time.
 *
 * The DNS TXT trio is decomposed as two pairwise checks
 * (`domainVerified ↔ domainVerifiedAt!=null` and
 * `domainVerified ↔ domainVerificationStatus==='verified'`); the third
 * edge follows by transitivity. A `discriminatedUnion` would express
 * this structurally but splinters every `CustomDomain` response into
 * multiple OpenAPI schemas, which tips the extractor into the same
 * `ZodCatch`-style limitation documented around #1653. The pairwise
 * refine also emits per-field `path` errors so `useAdminFetch`'s
 * `schema_mismatch` banner can point at the exact broken field.
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

export const CustomDomainSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    domain: z.string().min(1),
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
  })
  .superRefine((d, ctx) => {
    // DNS TXT trio: verifyDomainDnsTxt writes these three columns together.
    if (d.domainVerified !== (d.domainVerifiedAt !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "domainVerified and domainVerifiedAt must agree (both set or both unset).",
        path: ["domainVerifiedAt"],
      });
    }
    if (d.domainVerified !== (d.domainVerificationStatus === "verified")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "domainVerified must be true iff domainVerificationStatus === 'verified'.",
        path: ["domainVerificationStatus"],
      });
    }
    // Railway CNAME/cert: verifyDomain stamps verified_at when status flips to
    // 'verified'. The reverse doesn't hold — verified_at is preserved when
    // status regresses to 'pending'/'failed' — so this is a one-way check.
    if (d.status === "verified" && d.verifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verifiedAt must be set when status === 'verified'.",
        path: ["verifiedAt"],
      });
    }
  }) satisfies z.ZodType<CustomDomain>;
