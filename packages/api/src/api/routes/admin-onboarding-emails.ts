/**
 * Admin onboarding email routes.
 *
 * Mounted under /api/v1/admin/onboarding-emails. All routes require admin role.
 * Provides visibility into the onboarding email sequence for workspace users.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { adminAuthPreamble } from "./admin-auth";
import {
  getOnboardingStatuses,
  isOnboardingEmailEnabled,
} from "@atlas/api/lib/email/engine";
import { ONBOARDING_SEQUENCE } from "@atlas/api/lib/email/sequence";
import { ONBOARDING_EMAIL_STEPS, ONBOARDING_MILESTONES } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-onboarding-emails");

const stepEnum = z.enum(ONBOARDING_EMAIL_STEPS);
const milestoneEnum = z.enum(ONBOARDING_MILESTONES);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OnboardingEmailStatusSchema = z.object({
  userId: z.string(),
  email: z.string(),
  orgId: z.string(),
  sentSteps: z.array(stepEnum),
  pendingSteps: z.array(stepEnum),
  unsubscribed: z.boolean(),
  createdAt: z.string(),
});

const SequenceStepSchema = z.object({
  step: stepEnum,
  trigger: milestoneEnum,
  fallbackHours: z.number(),
  subject: z.string(),
  description: z.string(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listStatusesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Onboarding Emails"],
  summary: "List onboarding email statuses",
  description: "Returns onboarding email progress for users in the authenticated admin's organization.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ description: "Max results (default 50)" }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "List of user onboarding email statuses",
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            statuses: z.array(OnboardingEmailStatusSchema),
            total: z.number(),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSequenceRoute = createRoute({
  method: "get",
  path: "/sequence",
  tags: ["Admin — Onboarding Emails"],
  summary: "Get onboarding email sequence definition",
  description: "Returns the configured onboarding email sequence steps with triggers and timing.",
  responses: {
    200: {
      description: "Sequence steps",
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            steps: z.array(SequenceStepSchema),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminOnboardingEmails = new OpenAPIHono({ defaultHook: validationHook });

adminOnboardingEmails.openapi(listStatusesRoute, async (c) => {
  const requestId = crypto.randomUUID();
  return withRequestContext({ requestId }, async () => {
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      if (preamble.headers) {
        for (const [k, v] of Object.entries(preamble.headers)) c.header(k, v);
      }
      return c.json(preamble.error, preamble.status as 401);
    }

    const { authResult } = preamble;
    const orgId = authResult.user?.activeOrganizationId;

    if (!orgId || !hasInternalDB()) {
      return c.json({
        enabled: false,
        statuses: [],
        total: 0,
      }, 200);
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

    try {
      const result = await getOnboardingStatuses(orgId, limit, offset);
      return c.json({
        enabled: isOnboardingEmailEnabled(),
        statuses: result.statuses,
        total: result.total,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to fetch onboarding statuses");
      return c.json({ error: "internal_error", message: "Failed to fetch onboarding email statuses.", requestId }, 500);
    }
  });
});

adminOnboardingEmails.openapi(getSequenceRoute, async (c) => {
  const requestId = crypto.randomUUID();
  return withRequestContext({ requestId }, async () => {
    const preamble = await adminAuthPreamble(c.req.raw, requestId);
    if ("error" in preamble) {
      if (preamble.headers) {
        for (const [k, v] of Object.entries(preamble.headers)) c.header(k, v);
      }
      return c.json(preamble.error, preamble.status as 401);
    }

    return c.json({
      enabled: isOnboardingEmailEnabled(),
      steps: ONBOARDING_SEQUENCE.map((s) => ({
        step: s.step,
        trigger: s.trigger,
        fallbackHours: s.fallbackHours,
        subject: s.subject,
        description: s.description,
      })),
    }, 200);
  });
});
