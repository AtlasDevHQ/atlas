import { Badge } from "@/components/ui/badge";
import type { AbuseLevel } from "@/ui/lib/types";

/**
 * Renders a color-coded badge for an abuse level. Accepts any string so list
 * responses (where the server types the field as a string union) and strictly
 * typed `AbuseLevel` callers can share the same helper.
 */
export function levelBadge(level: AbuseLevel | string) {
  switch (level) {
    case "warning":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        >
          Warning
        </Badge>
      );
    case "throttled":
      return (
        <Badge
          variant="outline"
          className="border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300"
        >
          Throttled
        </Badge>
      );
    case "suspended":
      return <Badge variant="destructive">Suspended</Badge>;
    default:
      return <Badge variant="outline">None</Badge>;
  }
}

export function triggerLabel(trigger: string | null): string {
  switch (trigger) {
    case "query_rate":
      return "Excessive queries";
    case "error_rate":
      return "High error rate";
    case "unique_tables":
      return "Unusual table access";
    case "manual":
      return "Manual action";
    default:
      return "—";
  }
}
