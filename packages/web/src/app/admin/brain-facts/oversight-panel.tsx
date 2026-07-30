"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  EyeOff,
  History,
  Info,
  Lock,
  ShieldAlert,
} from "lucide-react";
import type {
  BrainFactOversight,
  BrainFactOversightBucket,
  BrainFactWillSupersede,
} from "@/ui/lib/types";
import { BrainFactOversightClientSchema } from "@/ui/lib/admin-schemas";
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
 * `lib/brain/oversight.ts` for that rule. A withheld audience arrives with **no
 * `label` field at all** — the wire type's `discovered` arm cannot carry one —
 * and renders as an opaque handle. So the panel cannot leak by forgetting to
 * check a flag: there is nothing in the payload to leak.
 *
 * ## Collapsed by default, and the delta is not
 *
 * The breakdown is for the admin who has already been told there is a gap. The
 * gap itself is unconditional — an oversight surface that hides its own finding
 * behind a disclosure triangle is a surface nobody reads.
 */
export function OversightPanel() {
  const [open, setOpen] = useState(false);
  const { data, error, refetch } = useAdminFetch<BrainFactOversight>(
    "/api/v1/admin/brain-facts/oversight",
    { schema: BrainFactOversightClientSchema },
  );

  if (error) {
    // States the CONSEQUENCE, not just the failure. "Couldn't load a breakdown"
    // reads as cosmetic next to an enabled publish button; what the admin
    // actually needs to know is that the all-clear they are not seeing is
    // absent because Atlas could not check, not because there is nothing to
    // report.
    return (
      <Alert role="alert" variant="destructive">
        <AlertTriangle className="size-4" aria-hidden />
        <AlertDescription className="space-y-1">
          <p>
            Couldn&apos;t load the workspace fact breakdown, so Atlas can&apos;t tell you
            whether drafts exist outside your queue. Publishing is still workspace-wide.
          </p>
          <p className="text-xs opacity-90">{friendlyError(error)}</p>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!data) return null;

  const hidden = data.workspaceTotals.awaitingReview - data.reviewableAwaitingReview;

  return (
    <div className="space-y-3">
      {!data.countsConsistent ? (
        // NOT clamped to a reassuring zero. The producer refuses to clamp for
        // exactly this reason, and the first cut of this panel undid that with
        // `Math.max(0, …)` — rendering "nothing is hidden from you" out of a
        // state that proves no such thing, which is #4825's defect reproduced
        // by its own fix.
        <Alert role="alert">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription className="space-y-1">
            <p>
              Atlas can&apos;t work out right now how much of this workspace&apos;s
              backlog sits outside your queue — either two counts of the same workspace
              disagreed, or one of them didn&apos;t read back. Treat publishing as
              workspace-wide, and treat the counts below as possibly incomplete; Atlas
              logged the reason.
            </p>
            {/* A real button. "Check back in a moment" is inert inside
                TanStack's 30s staleTime — a reload would replay the identical
                response during exactly the window a transient fault clears. */}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        hidden > 0 && (
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
              They belong to audiences you are not part of — usually private channels — so
              Atlas will not show you what they say, and reviewing them is federated to
              those audiences&apos; members. Publishing promotes them anyway: it is
              workspace-wide and always has been. The breakdown below says where they sit,
              in counts.
            </AlertDescription>
          </Alert>
        )
      )}

      {data.willSupersede && data.willSupersede.total > 0 && (
        <WillSupersedeNotice willSupersede={data.willSupersede} />
      )}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <ChevronDown
              className={`mr-1.5 size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
              aria-hidden
            />
            Workspace breakdown
            {/* `distinctAudiences`, never `buckets.length`: the array is capped
                and stops being the cardinality the moment truncation bites, and
                the correction lives inside the collapsed content where nobody
                would read it. */}
            <span className="ml-1.5 text-xs">
              ({data.workspaceTotals.awaitingReview.toLocaleString()} awaiting review across{" "}
              {data.distinctAudiences.toLocaleString()}{" "}
              {data.distinctAudiences === 1 ? "audience" : "audiences"})
            </span>
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-2">
          {data.bucketsTruncated && (
            <Alert className="mb-3">
              <ShieldAlert className="size-4" aria-hidden />
              <AlertDescription>
                This workspace has more distinct audiences than Atlas shows at once, so
                the rows below are a subset.
                {/* The exactness claim is CONDITIONAL. Under a degraded counter
                    the audience count is floored at the number of rows shipping
                    — i.e. it is the cap, not the cardinality — so asserting it
                    stays exact would be the one confident sentence on a screen
                    that has already said its numbers are not trustworthy. */}
                {data.countsConsistent
                  ? " The totals are not — they are counted per fact, and the audience count above is uncapped, so both stay exact."
                  : " Atlas also couldn't read one of the counts back this time, so the totals and the audience count above may be incomplete too."}
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
 * What the next publish will SUPERSEDE (#4912) — the temporal half of the
 * pre-publish disclosure, beside #4825's hidden-backlog half above it.
 *
 * `role="alert"` for the hidden-drafts alert's reason: this IS a finding, not
 * decoration — a publish that replaces a current belief must be read before
 * the button, because afterwards the superseded side is hidden from every
 * default read and nobody can notice a fact they can no longer see.
 *
 * The pairs render both claims verbatim — they are reader-ACL-gated by the
 * API on BOTH sides, so everything here is a claim this reader's own queue
 * already shows them. Supersessions the reader may not see arrive only as
 * `withheld`, a count; there is nothing in the payload to leak, same as the
 * withheld buckets.
 */
function WillSupersedeNotice({ willSupersede }: { willSupersede: BrainFactWillSupersede }) {
  // `total`, never `pairs.length + withheld` — the pairs are capped, and the
  // headline must not understate the moment truncation bites.
  const { total, pairs, withheld, truncated } = willSupersede;
  return (
    <Alert role="alert">
      <History className="size-4" aria-hidden />
      <AlertDescription className="min-w-0 space-y-2">
        <p>
          <span className="font-medium">
            Publishing will supersede{" "}
            {total === 1 ? "1 published fact." : `${total.toLocaleString()} published facts.`}
          </span>{" "}
          A new value for a single-valued predicate replaces the old one: the old fact keeps its
          history and stays readable to as-of questions, but stops being served as current belief.
          Nothing is deleted. Retract the draft instead if the old value is still right.
        </p>
        {pairs.length > 0 && (
          <ul className="space-y-1">
            {pairs.map((pair) => (
              <li
                key={`${pair.draftId}:${pair.supersededId}`}
                className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs"
              >
                <span className="truncate font-mono" title={pair.draftLabel}>
                  {pair.draftLabel}
                </span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-label="replaces" />
                <span
                  className="truncate font-mono text-muted-foreground line-through"
                  title={pair.supersededLabel}
                >
                  {pair.supersededLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
        {withheld > 0 && (
          <p className="text-xs text-muted-foreground">
            {withheld === 1
              ? "1 of these replacements involves facts"
              : `${withheld.toLocaleString()} of these replacements involve facts`}{" "}
            from audiences you are not part of, so the claims are not shown. Publishing performs{" "}
            {withheld === 1 ? "it" : "them"} anyway — publish is workspace-wide.
          </p>
        )}
        {truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the first {pairs.length.toLocaleString()} replacements you can review; the
            rest are yours to see too but did not fit in one response.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * One audience's row.
 *
 * Branches on `labelPolicy`, the wire type's DISCRIMINANT. `label === null` is
 * not even expressible: `BrainFactOversightBucket`'s withheld arm has no `label`
 * property at all, so `bucket.label` does not typecheck in this branch, and a
 * payload that smuggled one cannot be rendered by accident. The label is
 * whatever the API sent or an explanation of why it sent none — never a
 * reconstruction.
 */
function BucketRow({ bucket }: { bucket: BrainFactOversightBucket }) {
  return (
    <TableRow>
      <TableCell className="max-w-xs">
        {bucket.labelPolicy === "discovered" ? (
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
                  : // Hedged, because `loadConfiguredChannels` degrades to "nothing
                    // is configured" on a read fault — fail-closed and correct, but it
                    // makes every configured channel classify as discovered. Asserting
                    // the cause outright would be a confident fabrication for a
                    // `workspace_plugins` blip, which is the defect
                    // `brainFactsScopeUnavailable` exists to prevent one modal over.
                    "Atlas isn't showing this audience's name — either you didn't configure it, in which case naming it would disclose that the channel exists, or Atlas couldn't read the install config just now."}
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
