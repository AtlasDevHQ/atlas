/**
 * `/api/v1/admin/connection-groups` — admin management of per-Connection-group
 * Source-catalog descriptions (ADR-0022 §4, slice (b) #3894).
 *
 * The agent routes off a compact Source catalog (one entry per SQL group + REST
 * datasource). Each SQL group's description is auto-generated from its entities
 * at `/wizard/save` and **operator-refinable** here — a customer admin's edit
 * stamps `source = 'manual'` and is never clobbered by a later re-profile.
 *
 *   - `GET  /`           → list the org's group descriptions (with provenance).
 *   - `PATCH /{groupId}` → set (or clear, with a blank body) a group's
 *                          description. A non-blank value becomes the manual
 *                          override; a blank value deletes the row, reverting the
 *                          catalog to the auto seed / entity-name fallback.
 *
 * Admin-only (`admin:connections`, same flag as connection CRUD — group
 * descriptions are connection-group metadata). Scoped to the caller's active org.
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  ConnectionGroupDescriptionsResponseSchema,
  MAX_GROUP_DESCRIPTION_CHARS,
} from "@useatlas/schemas";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { createLogger } from "@atlas/api/lib/logger";
import {
  listGroupDescriptions,
  setManualGroupDescription,
} from "@atlas/api/lib/db/connection-group-descriptions";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-connection-group-descriptions");

// Wire shapes are single-sourced in `@useatlas/schemas` (shared with the web
// editor's response parsing) so the API and UI can't drift — see ADR-0022 §4.
const ListResponseSchema = ConnectionGroupDescriptionsResponseSchema;

const PatchBodySchema = z.object({
  // Empty string clears the override (reverts to the auto seed / fallback).
  description: z.string().max(MAX_GROUP_DESCRIPTION_CHARS),
});

const PatchResponseSchema = z.object({
  groupId: z.string(),
  // `false` after a clear — the row was deleted and the catalog falls back.
  present: z.boolean(),
  description: z.string().nullable(),
  source: z.enum(["manual"]).nullable(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Connection Groups"],
  summary: "List connection-group Source-catalog descriptions",
  description:
    "Returns the per-Connection-group descriptions feeding the agent Source catalog, with provenance (auto vs manual). Scoped to the active organization.",
  responses: {
    200: { description: "Group descriptions", content: { "application/json": { schema: ListResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{groupId}",
  tags: ["Admin — Connection Groups"],
  summary: "Set or clear a connection-group description",
  description:
    "Sets the manual Source-catalog description for a Connection group (a blank value clears it, reverting to the auto-generated seed). Scoped to the active organization.",
  request: {
    params: z.object({ groupId: z.string().min(1).max(128) }),
    body: { content: { "application/json": { schema: PatchBodySchema } } },
  },
  responses: {
    200: { description: "Description updated", content: { "application/json": { schema: PatchResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminConnectionGroupDescriptions = createAdminRouter();
adminConnectionGroupDescriptions.use(requireOrgContext());
adminConnectionGroupDescriptions.use(requirePermission("admin:connections"));

adminConnectionGroupDescriptions.openapi(listRoute, async (c) =>
  runHandler(c, "list connection-group descriptions", async () => {
    const { orgId } = c.get("orgContext");
    const rows = await listGroupDescriptions(orgId);
    return c.json({ descriptions: rows.map((r) => ({ ...r })) }, 200);
  }),
);

adminConnectionGroupDescriptions.openapi(patchRoute, async (c) =>
  runHandler(c, "set connection-group description", async () => {
    const { orgId } = c.get("orgContext");
    const { groupId } = c.req.valid("param");
    const { description } = c.req.valid("json");

    const present = await setManualGroupDescription(orgId, groupId, description);
    log.info(
      { orgId, groupId, present },
      present ? "Set manual group description" : "Cleared group description",
    );
    return c.json(
      {
        groupId,
        present,
        description: present ? description.trim().slice(0, MAX_GROUP_DESCRIPTION_CHARS) : null,
        source: present ? ("manual" as const) : null,
      },
      200,
    );
  }),
);

export { adminConnectionGroupDescriptions };
