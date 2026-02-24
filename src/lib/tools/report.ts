/**
 * Report finalization tool.
 *
 * The agent calls this when it has a complete answer. Includes the SQL used,
 * the data, and a narrative interpretation. This signals the agent loop to stop.
 */

import { tool } from "ai";
import { z } from "zod";

export const finalizeReport = tool({
  description: `Call this tool when you have fully answered the user's question. Provide the final SQL query, results as CSV, and a narrative interpretation.

The narrative should:
- Directly answer the question asked
- Highlight key numbers and trends
- Note any caveats or limitations in the data
- Be concise (2-4 paragraphs max)`,

  inputSchema: z.object({
    sql: z.string().describe("The final SQL query that produced the answer"),
    csvResults: z
      .string()
      .describe("Query results formatted as CSV with headers"),
    narrative: z
      .string()
      .describe("Human-readable interpretation of the results"),
  }),

  execute: async ({ sql, csvResults, narrative }) => {
    return { sql, csvResults, narrative };
  },
});
