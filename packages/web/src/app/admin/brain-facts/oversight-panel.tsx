"use client";

import { useState } from "react";
import { ChevronDown, EyeOff, Info, Lock, ShieldAlert } from "lucide-react";
import type { BrainFactOversight, BrainFactOversightBucket } from "@/ui/lib/types";
import { BrainFactOversightSchema } from "@/ui/lib/admin-schemas";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/lib/fetch-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Where the workspace's facts really stand — counts, never claims (#4825).
 *
 * ## The one sentence this panel exists to make true
 *
 * Publish is workspace-scoped; the queue above it is scoped to whoever is
 * looking. Before this panel, an admin outside a private channel's audience saw
 * a queue of 26, pressed publish, and promoted 32 — each number correct, the
 * pair inexplicable. So the headline here is not a table, it is the DELTA:
 * *"N drafts are not in your queue."*
 *
 * It never widens what anyone may read. Everything below is a number, and the
 * only text is a grant token the API already decided was disclosable — see
 * `lib/brain/oversight.ts` for that rule. A withheld audience arrives as
 * `label: null` and renders as an opaque handle, so the panel cannot leak by
 * forgetting to check a flag: there is nothing in the payload to leak.
 *
 * ## Collapsed by default, and the delta is not
 *
 * The breakdown is for the admin who has already been told there is a gap. The
 * gap itself is unconditional — an oversight surface that hides its own finding
 * behind a disclosure triangle is a surface nobody reads.
 */
export function OversightPanel() {
  const [open, setOpen] = useState(false);
  const { data, error } = useAdminFetch<BrainFactOversight>(
    "/api/v1/admin/brain-facts/oversight",
    { schema: BrainFactOversightSchema },
  );

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Couldn&apos;t load the workspace fact breakdown: {friendlyError(error)}
      </p>
    );
  }
  if (!data) return null;

  const hidden = Math.max(0, data.workspaceTotals.awaitingReview - data.reviewableAwaitingReview);

  return (
    <div className="space-y-3">
      {hidden > 0 && (
        // `role="alert"` deliberately: this is the finding, not decoration. An
        // admin reaching the publish button without having read it is the exact
        // failure #4825 recorded.
        <Alert role="alert">
          <Lock className="size-4" aria-hidden />
          <AlertDescription>
            <span className="font-medium">
              {hidden === 1
                ? "1 draft awaiting review is not in your queue."
                : `${hidden.toLocaleString()} drafts awaiting review are not in your queue.`}
            </span>{" "}
            They came from channels you are not a member of, so Atlas will not
            show you what they say — reviewing them is federated to those
            channels&apos; members. Publishing promotes them anyway: it is
            workspace-wide and always has been. The breakdown below says where
            they sit, in counts.
          </AlertDescription>
        </Alert>
      )}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <ChevronDown
              className={`mr-1.5 size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
              aria-hidden
            />
            Workspace breakdown
            <span className="ml-1.5 text-xs">
              ({data.workspaceTotals.awaitingReview.toLocaleString()} awaiting review across{" "}
              {data.buckets.length.toLocaleString()}{" "}
              {data.buckets.length === 1 ? "audience" : "audiences"})
            </span>
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-2">
          {data.bucketsTruncated && (
            <Alert className="mb-3">
              <ShieldAlert className="size-4" aria-hidden />
              <AlertDescription>
                This workspace has more distinct audiences than Atlas shows at once, so
                the rows below are a subset. The totals are not — they are counted per
                fact, so the numbers above stay exact.
              </AlertDescription>
            </Alert>
          )}

          {/* `min-w-0` on the scroll container: without it a wide table forces
              the whole admin page to scroll horizontally. */}
          <div className="min-w-0 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Audience</TableHead>
                  <TableHead className="text-right">Awaiting review</TableHead>
                  <TableHead className="text-right">Published</TableHead>
                  <TableHead className="text-right">Retracted</TableHead>
                  <TableHead className="text-right">Provisional</TableHead>
                  <TableHead className="text-right">In tension</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.buckets.map((bucket) => (
                  <BucketRow key={bucket.key} bucket={bucket} />
                ))}
                <TableRow className="border-t-2 font-medium">
                  <TableCell>Workspace total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.workspaceTotals.awaitingReview.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.workspaceTotals.published.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.workspaceTotals.retracted.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.workspaceTotals.provisional.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.workspaceTotals.inTension.toLocaleString()}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Stated, not implied. A fact granted to two audiences is counted in
              both rows, so a reader adding the column up and finding it larger
              than the total would otherwise conclude one of the two is wrong. */}
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              A fact is counted once per audience its grant names, so rows overlap and
              do not sum to the workspace total. Counts only — no claim, evidence, or
              author reaches this view.
            </span>
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * One audience's row.
 *
 * The label is whatever the API sent, or an explanation of why it sent none —
 * never a reconstruction. `label === null` is the ONLY signal this component
 * has, and it is sufficient: the withheld id is not in the payload at all.
 */
function BucketRow({ bucket }: { bucket: BrainFactOversightBucket }) {
  return (
    <TableRow>
      <TableCell className="max-w-xs">
        {bucket.label === null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <EyeOff className="size-3.5 shrink-0" aria-hidden />
                <span className="font-mono text-xs">{bucket.key}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {bucket.kind === "user"
                ? "One person's private facts. Atlas resolved them from a source roster rather than you naming them, so the account is not shown."
                : bucket.kind === "malformed"
                  ? "These facts carry a visibility token Atlas does not recognise, which grants nobody access on its own. The token is stored text and is not rendered here."
                  : "An audience Atlas discovered rather than one you configured. Naming it would disclose that the channel exists, which the counts alone do not."}
            </TooltipContent>
          </Tooltip>
        ) : bucket.kind === "org" ? (
          <span>Everyone in the workspace</span>
        ) : (
          <span className="truncate font-mono text-xs" title={bucket.label}>
            {bucket.label}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.awaitingReview.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.published.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.retracted.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.provisional.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.inTension.toLocaleString()}
      </TableCell>
    </TableRow>
  );
}
