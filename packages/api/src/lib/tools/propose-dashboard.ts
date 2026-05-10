import { tool } from "ai";
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import { CardLayoutSchema } from "@atlas/api/lib/dashboards";

const log = createLogger("tool:propose-dashboard");

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
  connectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Source connection — omit for the default datasource."),
});

export const proposeDashboard = tool({
  description: `Propose a dashboard spec for the user to preview and save.

Use this AFTER you have used executeSQL to confirm each card's query shape (so you know its column names). The spec is rendered live in a side canvas; nothing is persisted until the user clicks Save.

A typical flow:
1. Use explore + executeSQL to understand the data and run each card's query at least once.
2. Call proposeDashboard with a title and 1-12 cards. Each card needs: title, sql, chartConfig. Pass the same connectionId you used in executeSQL — omit only when the card targets the default datasource.
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
          const validation = await validateSQL(card.sql, card.connectionId);
          return {
            card,
            index: idx,
            validation: validation.valid
              ? ({ valid: true } as const)
              : ({ valid: false, error: validation.error } as const),
          };
        }),
      );

      const errors = validatedCards
        .filter((c): c is typeof c & { validation: { valid: false; error: string } } => !c.validation.valid)
        .map((c) => ({
          cardIndex: c.index,
          cardTitle: c.card.title,
          error: c.validation.error,
        }));

      if (errors.length > 0) {
        log.warn({ invalid: errors }, "proposeDashboard produced invalid SQL — surfacing to canvas");
      }

      return {
        kind: "ok" as const,
        spec: {
          title,
          ...(description ? { description } : {}),
          cards: validatedCards.map(({ card }) => card),
        },
        validation: {
          allValid: errors.length === 0,
          errors,
        },
      };
    } catch (err) {
      // Log the raw error server-side; return a sanitized message to the agent
      // so we never leak stack traces / connection strings through the tool
      // result envelope (CLAUDE.md "No secrets in responses").
      log.warn(
        { err: err instanceof Error ? err.message : String(err), title },
        "proposeDashboard failed unexpectedly",
      );
      return {
        kind: "err" as const,
        error: "The dashboard tool failed unexpectedly. Try again or simplify the proposal.",
      };
    }
  },
});
