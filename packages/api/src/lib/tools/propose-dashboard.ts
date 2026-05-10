/**
 * proposeDashboard tool — emit a dashboard spec for live preview in the canvas.
 *
 * The tool does NOT persist anything. It validates each card's SQL through
 * the same pipeline as executeSQL and returns the (possibly annotated) spec.
 * The frontend renders the spec in a side canvas; the user clicks Save to
 * create the dashboard via POST /api/v1/dashboards + POST .../cards.
 */

import { tool } from "ai";
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { validateSQL } from "@atlas/api/lib/tools/sql";

const log = createLogger("tool:propose-dashboard");

const CardLayoutSchema = z.object({
  x: z.number().int().min(0).max(24),
  y: z.number().int().min(0),
  w: z.number().int().min(3).max(24),
  h: z.number().int().min(4).max(200),
});

const ChartConfigSchema = z.object({
  type: z.enum(CHART_TYPES),
  categoryColumn: z.string().min(1),
  valueColumns: z.array(z.string().min(1)).min(1),
});

const CardSchema = z.object({
  title: z.string().min(1).max(200),
  sql: z.string().min(1),
  chartConfig: ChartConfigSchema,
  layout: CardLayoutSchema.optional(),
});

export const proposeDashboard = tool({
  description: `Propose a dashboard spec for the user to preview and save.

Use this AFTER you have used executeSQL to confirm each card's query shape (so you know its column names). The spec is rendered live in a side canvas; nothing is persisted until the user clicks Save.

A typical flow:
1. Use explore + executeSQL to understand the data and run each card's query at least once.
2. Call proposeDashboard with a title and 1-6 cards. Each card needs: title, sql, chartConfig.
3. The user reviews the live preview, optionally tweaks layout/chart types, and clicks Save.

Layout is optional — the canvas auto-arranges cards if you omit it. Grid is 24 columns wide; common widths are 12 (half) and 24 (full); common heights are 8 (chart) and 4 (KPI / small table). chartConfig.type is one of: ${CHART_TYPES.join(", ")}.

You can call this multiple times in the same conversation — each call replaces the canvas state, so users iterate by saying things like "make card 2 a bar chart" and you re-emit the whole spec.`,

  inputSchema: z.object({
    title: z.string().min(1).max(200).describe("Dashboard title"),
    description: z
      .string()
      .max(2000)
      .optional()
      .describe("Optional one-line description of what the dashboard shows"),
    cards: z.array(CardSchema).min(1).max(12).describe("Cards to render"),
  }),

  execute: async ({ title, description, cards }) => {
    try {
      const validatedCards = await Promise.all(
        cards.map(async (card, idx) => {
          const validation = await validateSQL(card.sql);
          return {
            ...card,
            validation: validation.valid
              ? ({ valid: true } as const)
              : ({ valid: false, error: validation.error } as const),
            index: idx,
          };
        }),
      );

      const invalid = validatedCards.filter((c) => !c.validation.valid);
      if (invalid.length > 0) {
        log.warn(
          { invalid: invalid.map((c) => ({ idx: c.index, title: c.title, error: c.validation.valid ? null : c.validation.error })) },
          "proposeDashboard produced invalid SQL — surfacing to canvas",
        );
      }

      return {
        spec: {
          title,
          ...(description ? { description } : {}),
          cards: validatedCards.map(({ validation: _v, index: _i, ...rest }) => rest),
        },
        validation: {
          allValid: invalid.length === 0,
          errors: invalid.map((c) => ({
            cardIndex: c.index,
            cardTitle: c.title,
            error: c.validation.valid ? "" : c.validation.error,
          })),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, title }, "proposeDashboard failed");
      return {
        error: `Failed to propose dashboard: ${msg}`,
      };
    }
  },
});
