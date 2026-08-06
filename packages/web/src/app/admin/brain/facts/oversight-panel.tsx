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
  Users,
} from "lucide-react";
import type {
  BrainFactOversight,
  BrainFactOversightBucket,
  BrainFactWillSupersede,
  BrainFactWillWiden,
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
    //
    // ⚠️ Names ALL THREE disclosures, because one request carries all three and
    // any one loader failing 500s the lot. The copy predated #4912 and #5032 and
    // named only the counts, so an admin read it as "the breakdown is missing"
    // and had no way to learn that the supersession preview and the widening
    // notice were absent too — with publish still one click away.
    return (
      <Alert role="alert" variant="destructive">
        <AlertTriangle className="size-4" aria-hidden />
        <AlertDescription className="space-y-1">
          <p>
            Couldn&apos;t load the workspace fact breakdown, so Atlas can&apos;t tell you
            whether drafts exist outside your queue, what this publish will supersede, or
            whose audience it will widen. Publishing is still workspace-wide.
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

      {/* `pairs.length > 0` is ORed in: under the two-statement race the API
          documents, `total` can read 0 while pairs exist — and pairs in hand
          are proof of supersessions regardless of what the count said. Gating
          on `total` alone would render NO disclosure in exactly that window. */}
      {data.willSupersede &&
        (data.willSupersede.total > 0 || data.willSupersede.pairs.length > 0) && (
          <WillSupersedeNotice willSupersede={data.willSupersede} />
        )}

      {/* ⚠️ `|| incomplete` is NOT belt-and-braces — it is the whole reason the
          flag exists. `{ total: 0, entries: [], incomplete: true }` is a fully
          reachable, schema-valid response: query drift drops the rows, so the
          drafts that would have widened are missing from the LIST and from the
          COUNT. Gated on `entries.length` alone this renders a clean panel with
          a live publish button, and the admin publishes an ACL change they were
          never shown — which is the one failure this surface exists to prevent,
          in the direction nobody can report afterwards (you cannot notice that a
          fact became readable to somebody else).

          `total > 0` is ORed in for the will-supersede gate's reason, which
          applies here verbatim: a count without a list is still proof that
          something widens, and the schema's cross-check only forbids the
          OPPOSITE skew (`entries.length > total`). Today's producer cannot emit
          it — `total` is `entries.length` before the slice — but it is one
          entry-level filter away, and the sibling disclosure already pays for
          the mirror shape.

          `truncated` is deliberately NOT in the gate: it is only ever set
          alongside a non-empty list. */}
      {data.willWiden &&
        (data.willWiden.entries.length > 0 ||
          data.willWiden.total > 0 ||
          data.willWiden.incomplete) && <WillWidenNotice willWiden={data.willWiden} />}

      {/* ⚠️ The EMPTY-and-complete case, which had no disclosure at all until
          #5032's panel round 4 — and it is the fail-open one.

          `loadWideningPreview` is READER-SCOPED and has no `withheld`
          counterpart (its own docstring says an empty `entries` means "none that
          you can see", never "none"). So an admin whose widening drafts all sit
          in audiences they are not part of gets `{ total: 0, entries: [],
          incomplete: false }` — a legitimately complete answer about *their*
          scope, and a false all-clear about the workspace. The one sentence that
          says so lives inside `WillWidenNotice`, which is exactly the component
          that does not render here: the hedge was present whenever it was
          redundant and absent whenever it was load-bearing.

          Gated so it does not shout on a genuinely complete panel. `hidden > 0`
          means drafts demonstrably sit outside this reader's queue, so the scan
          demonstrably did not cover them; `!countsConsistent` means Atlas cannot
          work out whether they do, which needs the same hedge for the same
          reason. When both are clear the reader sees the whole backlog and an
          empty result really does mean none — the one case that may stay silent.

          NOT `role="alert"`: the sibling notices are findings, and this is the
          absence of one. Announcing "nothing was found, in a scope that may be
          partial" over the top of the hidden-backlog alert — which is already an
          alert, already says publishing is workspace-wide, and is the thing that
          made `hidden > 0` true — would bury the finding under its own caveat. */}
      {data.willWiden &&
        data.willWiden.entries.length === 0 &&
        data.willWiden.total === 0 &&
        !data.willWiden.incomplete &&
        (hidden > 0 || !data.countsConsistent) && (
          <p className="text-xs text-muted-foreground">
            No audience widening was found among the facts you can review. Publish is
            workspace-wide, so drafts outside your queue were not checked and may still
            widen when you publish.
          </p>
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
 * API on BOTH sides, so everything here is a claim this reader's own ACL
 * already entitles them to read. Supersessions the reader may not see arrive only as
 * `withheld`, a count; there is nothing in the payload to leak, same as the
 * withheld buckets.
 */
function WillSupersedeNotice({ willSupersede }: { willSupersede: BrainFactWillSupersede }) {
  // `total` leads, never `pairs.length + withheld` — the pairs are capped, and
  // the headline must not understate the moment truncation bites. The
  // `Math.max` floor covers the opposite, racier corner: pairs in hand with a
  // stale 0 total (the API's two-statement race) must still headline as at
  // least what is visibly listed below.
  const { pairs, withheld, truncated } = willSupersede;
  const total = Math.max(willSupersede.total, pairs.length + withheld);
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
 * What the next publish will make VISIBLE TO MORE PEOPLE (#5032) — the third
 * half of the pre-publish disclosure, beside the hidden backlog and the
 * supersession notice.
 *
 * Publishing a draft unions in the grant of every episode already recorded as
 * evidence for it (#4823), so a claim first seen in a private channel and
 * restated in a public one stops being served only to the private audience.
 * That is usually right. It is wrong when two different entities share a name:
 * corroboration matches on identity derived from the SURFACE, so a public
 * episode about one `Acme Corp` can become evidence for a private fact about
 * another — and the widening then hands its audience the private claim's body.
 * The API can prove that away only for warehouse-backed subjects; for everything
 * else this notice is the guard.
 *
 * `role="alert"` for the supersession notice's reason, and more so: an ACL
 * change is invisible afterwards in the one direction nobody can report — you
 * cannot notice that a fact became readable to somebody else.
 *
 * The claims render verbatim because the API gates each entry on this reader's
 * own ACL. The token list renders verbatim too, and is the SAME list the
 * post-publish record already reports to this admin one moment later.
 *
 * ⚠️ The copy must not promise completeness. There is no `withheld` counterpart
 * on this disclosure (the API's own docstring says why), so "that you can see"
 * is load-bearing rather than hedging.
 */
function WillWidenNotice({ willWiden }: { willWiden: BrainFactWillWiden }) {
  const { entries, total, truncated, incomplete } = willWiden;
  // Floored at what is visibly listed, mirroring the supersession notice: a
  // headline smaller than the list below it reads as a bug to the one person
  // who most needs to trust this screen.
  const count = Math.max(total, entries.length);
  return (
    <Alert role="alert">
      <Users className="size-4" aria-hidden />
      <AlertDescription className="min-w-0 space-y-2">
        {/* The headline states what Atlas KNOWS. On the `incomplete` path it
            knows a lower bound and nothing more, so it must not lead with a
            number that reads as the answer — the count moves into the sentence
            below, where "at least" can qualify it honestly. */}
        <p>
          <span className="font-medium">
            {incomplete
              ? "Publishing may widen the audience of more facts than Atlas can list."
              : `Publishing will widen the audience of ${
                  count === 1 ? "1 fact." : `${count.toLocaleString()} facts.`
                }`}
          </span>{" "}
          Each of these was first recorded from a narrower audience and has since been
          corroborated by evidence from a wider one, so publishing serves it to both. Check that
          the wider evidence is really about the same thing — two different subjects with the same
          name look identical here. Retract the draft instead if it is not.
        </p>
        {incomplete && (
          <p className="text-xs text-muted-foreground">
            Atlas could not evaluate every draft this time, so both the list and the count
            understate what publishing will widen — treat it as widening more than is shown. This
            is an Atlas fault, not an audience boundary.
          </p>
        )}
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li
              key={entry.factId}
              className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs"
            >
              <span className="truncate font-mono" title={entry.label}>
                {entry.label}
              </span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-label="becomes visible to" />
              <span className="truncate font-mono text-muted-foreground" title={entry.added.join(", ")}>
                {entry.added.join(", ")}
              </span>
            </li>
          ))}
        </ul>
        {/* ONLY the cap. This sentence claims the remainder exists, is yours,
            and is counted in the headline — all true when the list was clipped
            and all false when a row was dropped, which is what `incomplete`
            says instead. One boolean carrying both made this copy a confident,
            specific, wrong explanation on the drift path. */}
        {truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the first {entries.length.toLocaleString()}; the rest are yours to see too but
            did not fit in one response.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Only facts you can review are listed. Publish is workspace-wide, so it may widen others
          you are not part of.
        </p>
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
