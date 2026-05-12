"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Lightweight summary used by the chat empty state to surface "Atlas knows
 * N tables in your data" — directly serves the .impeccable.md "Transparency
 * builds trust" principle. Any non-OK response soft-fails to `null` so the
 * empty state collapses to a neutral headline rather than throwing — the
 * status and request id are logged so a backend regression isn't invisible
 * to operators.
 */
export interface DatasourceSummary {
  tableCount: number;
}

export function useDatasourceSummary({
  apiUrl,
  isCrossOrigin,
  getHeaders,
  enabled,
}: {
  apiUrl: string;
  isCrossOrigin: boolean;
  getHeaders: () => Record<string, string>;
  enabled: boolean;
}) {
  return useQuery<DatasourceSummary | null>({
    queryKey: ["atlas", "datasource-summary", apiUrl],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${apiUrl}/api/v1/semantic/entities`, {
        credentials: isCrossOrigin ? "include" : "same-origin",
        headers: getHeaders(),
        signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { requestId?: string };
        console.warn(
          "[datasource-summary] non-OK response",
          res.status,
          "requestId:",
          body.requestId,
        );
        return null;
      }
      const data = (await res.json()) as { entities?: unknown };
      const list = Array.isArray(data?.entities) ? data.entities : [];
      return { tableCount: list.length };
    },
    enabled,
    retry: 1,
    staleTime: 5 * 60_000,
  });
}
