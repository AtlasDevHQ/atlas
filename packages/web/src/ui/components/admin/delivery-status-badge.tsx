import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, XCircle, Clock, TriangleAlert } from "lucide-react";

export function DeliveryStatusBadge({ status, error }: { status: string | null; error: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;

  const badge = (() => {
    switch (status) {
      case "sent":
        return (
          <Badge variant="secondary" className="gap-1 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle2 className="size-3" />
            sent
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="size-3" />
            failed
          </Badge>
        );
      case "failed_permanent":
        // #3379 — every failure in the run was permanent (misconfiguration:
        // no email sender / no Slack token / blocked webhook URL), not a
        // transient outage. Distinct amber styling so admins know retrying
        // won't help — the deployment's sender config needs fixing.
        return (
          <Badge
            variant="secondary"
            className="gap-1 bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-400"
          >
            <TriangleAlert className="size-3" />
            failed — config
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="gap-1">
            <Clock className="size-3" />
            {status}
          </Badge>
        );
    }
  })();

  if ((status === "failed" || status === "failed_permanent") && error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{error}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return badge;
}
