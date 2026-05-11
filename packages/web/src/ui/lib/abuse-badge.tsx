"use client";

import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import type { AbuseLevel } from "@/ui/lib/types";

/**
 * Badge for the in-memory abuse level — distinct from the workspace
 * status badge (the `workspace_status` DB column flipped by admin
 * actions). The two can disagree (DB-active + abuse-suspended is the
 * #2269 bug) so callers render both alongside.
 *
 * Returns `null` for `"none"` and `undefined` (older API/web pair) so
 * the row stays uncluttered when there's nothing to surface. Treating
 * `undefined` like `"none"` is the conservative default — the audit
 * trail for divergence is then either present or absent based on the
 * server reporting it, never inferred from a missing field.
 */
export function abuseBadge(level: AbuseLevel | undefined) {
  switch (level) {
    case undefined:
    case "none":
      return null;
    case "warning":
      return (
        <Badge variant="outline" className="border-yellow-500 text-yellow-600 gap-1">
          Abuse: warning
        </Badge>
      );
    case "throttled":
      return (
        <Badge variant="outline" className="border-orange-500 text-orange-600 gap-1">
          Abuse: throttled
        </Badge>
      );
    case "suspended":
      return (
        <Badge variant="destructive" className="gap-1">
          Abuse: suspended
        </Badge>
      );
    default: {
      // Exhaustiveness check — a new `AbuseLevel` member fails compile
      // here, so the badge never silently renders nothing for a level
      // the wire format now supports.
      const _exhaustive: never = level;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Banner shown on the workspace detail surfaces when the abuse detector
 * has flagged a workspace whose `workspace_status` is still `"active"`.
 * Explains the divergence and links to the abuse console for reinstate.
 *
 * `level === undefined` (older API/web pair) and `"none"` both render
 * nothing — same conservative default as `abuseBadge`.
 */
export function AbuseDivergenceBanner({ level }: { level: AbuseLevel | undefined }) {
  if (!level || level === "none") return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 text-amber-600 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium text-amber-900 dark:text-amber-100">
          Abuse detector reports <span className="font-mono">{level}</span>.
        </p>
        <p className="text-amber-800 dark:text-amber-200">
          This is independent of the workspace status above — chat &amp; query
          requests are being blocked even if status reads &quot;active&quot;.{" "}
          <a href="/admin/abuse" className="underline underline-offset-2">
            Open Abuse Console
          </a>{" "}
          to reinstate.
        </p>
      </div>
    </div>
  );
}
