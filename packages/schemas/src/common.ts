/**
 * Shared primitives used across wire-format schemas.
 *
 * Grows with each family migration in #1648. Keep exports minimal — this
 * module is imported everywhere, so every addition should be something
 * reused by at least two schema families.
 */
import { z } from "zod";

/**
 * ISO-8601 timestamp string.
 *
 * Replaces bare `z.string()` for `createdAt` / `updatedAt` / `assignedAt` /
 * `requestedAt` / `completedAt` / `firedAt` / `resolvedAt` /
 * `acknowledgedAt` / `lastRequest` / `expiresAt` fields across the schema
 * families. Before this helper, every timestamp field accepted arbitrary
 * strings (including `"banana"`), which let server bugs leak through the
 * wire boundary silently. Apply progressively as each family is touched.
 */
export const IsoTimestampSchema = z.string().datetime();
