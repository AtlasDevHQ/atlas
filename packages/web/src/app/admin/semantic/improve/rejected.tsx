import { RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DiffViewer, formatAmendment } from "./amendment-display";
import type { TestResult } from "./proposals";

// ---------------------------------------------------------------------------
// Rejected view types + card (#4512)
//
// A rejected Amendment is the org's permanent rejection memory made visible.
// Reconsider is the one action that lifts a rejection — it returns the change
// to the Pending queue and makes its identity proposable again. Split out of
// page.tsx (like proposals.ts) so the card renders + its Reconsider affordance
// are unit-testable without the chat harness.
// ---------------------------------------------------------------------------

export interface RejectedAmendment {
  id: string;
  entityName: string;
  description: string | null;
  confidence: number;
  amendmentType: string | null;
  amendment: Record<string, unknown> | null;
  rationale: string | null;
  diff: string | null;
  testQuery: string | null;
  testResult: TestResult | null;
  /** When it was rejected (ISO); null on legacy rows. */
  rejectedAt: string | null;
  /** Who rejected it. */
  rejectedBy: string | null;
  createdAt: string;
}

/** Format the rejection timestamp for display; tolerant of a null/invalid value. */
function formatRejectedAt(rejectedAt: string | null): string | null {
  if (!rejectedAt) return null;
  const d = new Date(rejectedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function RejectedCard({
  amendment,
  onReconsider,
  reconsidering,
}: {
  amendment: RejectedAmendment;
  onReconsider: () => void;
  reconsidering: boolean;
}) {
  const rejectedOn = formatRejectedAt(amendment.rejectedAt);

  return (
    <Card className="shadow-none border">
      <CardHeader className="py-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span className="font-mono">{amendment.entityName}</span>
            {amendment.amendmentType && (
              <Badge variant="outline" className="text-[10px]">
                {amendment.amendmentType.replace(/_/g, " ")}
              </Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">
              rejected
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={onReconsider}
            disabled={reconsidering}
            className="gap-1.5 text-xs shrink-0"
          >
            {reconsidering ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            Reconsider
          </Button>
        </div>
      </CardHeader>
      <CardContent className="py-2 space-y-3">
        {amendment.rationale && (
          <p className="text-sm text-muted-foreground">{amendment.rationale}</p>
        )}

        {amendment.diff ? (
          <DiffViewer diff={amendment.diff} />
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
            {formatAmendment(amendment.amendmentType ?? "unknown", amendment.amendment ?? {})}
          </pre>
        )}

        <p className="text-[11px] text-muted-foreground">
          {rejectedOn ? `Rejected ${rejectedOn}` : "Rejected"}
          {amendment.rejectedBy ? ` by ${amendment.rejectedBy}` : ""}
          {" — Reconsider returns it to the pending queue and makes it proposable again."}
        </p>
      </CardContent>
    </Card>
  );
}
