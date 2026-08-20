"use client";

import Link from "next/link";
import type { z } from "zod";
import { AlertTriangle, ArrowRight, Brain, CircleDot, Hash, Split, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { AvailabilityArm, CoverageStatement } from "@/ui/components/admin/brain-coverage/arms";
import { hiddenBacklogSentence } from "@/ui/components/admin/brain-coverage/statement";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { BrainCoverageClientSchema, BrainSlackScopeVitalsSchema } from "@/ui/lib/admin-schemas";
import type { BrainCoverage } from "@/ui/lib/types";

type SlackScopeVitals = z.infer<typeof BrainSlackScopeVitalsSchema>;

/**
 * The **Coverage Surface** — the Company Atlas group's landing page (#5066,
 * evolved by #5215 under ADR-0041).
 *
 * ## Why this is one page and not two
 *
 * PRD condition 6 asks for ONE surface from which an admin states what Atlas
 * knows, how much of the company it covers, and what it does not — every part
 * correct, at 4% as clearly as at 80%. ADR-0041 § The surface decides that this
 * page becomes that surface rather than gaining a sibling: *"building coverage
 * beside an overview splits the statement across two."* So the old overview's
 * backlog counts did not move out of the way — they are the **authority arm**
 * (observed, awaiting review, federated elsewhere) beside the **availability
 * arm** (surveyed at all), which is ADR-0040's two-arm vocabulary as page
 * structure.
 *
 * ## The backlog counts changed meaning, deliberately
 *
 * They used to come from `GET /brain-facts/summary`, which is READER-SCOPED —
 * this admin's own queue. They now come from the coverage response's
 * `authority` arm, which is `oversight.ts`'s WORKSPACE-WIDE disclosure. That is
 * the right number for this page and it is what makes the hidden-backlog
 * sentence possible at all: publish is workspace-scoped, so an admin needs to be
 * able to tell a clean queue from a backlog federated to somebody else before
 * they press the button. The reader-scoped total still travels beside it
 * (`reviewableAwaitingReview`), which is how the delta is stated rather than
 * inferred.
 *
 * ## What it is NOT
 *
 * Not a second review queue. `/admin/brain/facts` owns reviewing, rejecting and
 * publishing; the numbers here are read-only signposts into it. Adding an action
 * would make `brain_facts.status` writable from two surfaces — the mistake the
 * facts page documents at length. `read-only-vitals.test.tsx` pins that
 * structurally: it fails the render if any endpoint outside the two read-only
 * GETs is touched.
 *
 * ## No new permission flag, on purpose
 *
 * The admin perimeter is the whole gate, same as the rest of `/admin/brain`. A
 * new workspace-permission flag would be implicitly denied to every
 * already-seeded workspace's built-in roles (the #5188 regression class), and
 * the unscoped counts here exist under a sanction argued for admins
 * specifically. ADR-0041 § The surface records both halves.
 *
 * ## Why the counts go through AdminContentWrapper rather than an ErrorBanner
 *
 * Every number here is a BACKLOG or a DENOMINATOR, so a failed read that
 * rendered as `0` would say "your queue is clear" and "nothing is unsurveyed" at
 * the exact moment nobody knows either. The wrapper is what keeps that honest
 * *and* correctly typed: the endpoint answers 404 when the internal database
 * isn't configured — the ordinary self-hosted state, not a fault — and 403 +
 * `mfa_enrollment_required` behind the enrollment dialog. A hand-rolled
 * `<ErrorBanner message={friendlyError(…)}>` flattens the structured error into
 * a string and loses that routing — the 404 arm keys on `FetchError.status`, the
 * MFA/enterprise arms on `.code` — greeting a self-hosted operator with a red
 * alert and a Retry button that cannot help.
 */
export default function CompanyAtlasCoverage() {
  const {
    data: coverage,
    loading,
    error,
    refetch,
  } = useAdminFetch<BrainCoverage>("/api/v1/admin/brain-coverage", {
    schema: BrainCoverageClientSchema,
  });
  // The Slack ingest verdict (#5203). This read is what makes a revoked Slack
  // credential VISIBLE: retiring `catalog:slack-history` removed the
  // collection card that used to render its sync state, so without this
  // section the sync's actionable "reconnect Slack…" error would be recorded
  // every cycle and presented to nobody. It sits beside the coverage read
  // rather than inside it because the two fail independently — a Slack
  // credential that stopped working must still surface on a page whose
  // enumeration snapshots load fine.
  const slack = useAdminFetch<SlackScopeVitals>("/api/v1/admin/brain-slack/channels", {
    schema: BrainSlackScopeVitalsSchema,
  });

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Company Atlas</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          What Atlas has learned about your business from the conversations it can see — claims
          pulled out of chat history, meeting transcripts and mail, held behind a review gate until
          a human accepts them. It never overrides your warehouse: where a learned fact and your
          data disagree, the data wins.
        </p>
      </div>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Company Atlas"
          onRetry={refetch}
          loadingMessage="Loading Company Atlas coverage..."
        >
          <CoverageSurface coverage={coverage} />
        </AdminContentWrapper>
      </ErrorBoundary>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={slack.loading}
          error={slack.error}
          feature="Company Atlas"
          onRetry={slack.refetch}
          loadingMessage="Loading Slack ingest status..."
        >
          <SlackIngestCard vitals={slack.data} />
        </AdminContentWrapper>
      </ErrorBoundary>

      {/* Deliberately OUTSIDE the wrapper. The wrapper replaces its children
          wholesale on error, and this card is the page's only in-content route
          into the review queue — a workspace whose coverage won't load is
          precisely the one whose admin wants to go look at the queue. */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <SurfaceCard
          href="/admin/brain/facts"
          title="Facts"
          description="The review queue. Reject what you don't trust, then publish what survives — publishing promotes every remaining draft in the workspace at once."
        />
      </div>
    </div>
  );
}

/** Both arms, under the composed statement. Rendered only once the wrapper has cleared. */
function CoverageSurface({ coverage }: { coverage: BrainCoverage | null }) {
  if (!coverage) {
    // Unreachable for THIS caller: `loading` stays true until data or error
    // exists, and the schema makes every arm required, so the wrapper has
    // already returned by now. (`useAdminFetch` CAN yield `loading: false,
    // data: null` under `enabled: false` — this page passes no `enabled`.)
    // Guarded for the SHAPE: `?? 0` would print a cleared backlog and an empty
    // map nobody measured, and `return null` would leave a silent hole where
    // the whole statement belongs.
    console.warn(
      "coverage surface: received coverage=null, which AdminContentWrapper's contract makes " +
        "unreachable (/api/v1/admin/brain-coverage) — rendering no statement rather than zeros " +
        "that would read as an empty queue over a complete map",
    );
    return (
      <p className="text-sm text-muted-foreground">
        The coverage statement is unavailable. Open Facts below to review the queue directly.
      </p>
    );
  }

  return (
    <div className="space-y-6" data-testid="coverage-surface">
      <CoverageStatement coverage={coverage} />
      <AvailabilityArm coverage={coverage} />
      <AuthorityArm coverage={coverage} />
    </div>
  );
}

/**
 * The authority arm — the old overview's four backlog counts, inside the
 * statement rather than beside it.
 *
 * Workspace-wide, not reader-scoped: see the page header. The hidden-backlog
 * line beneath the tiles is the disclosure that number exists for, and it is
 * gated on `countsConsistent` because the two totals are separate statements on
 * a pool and a brief ingest race can invert them — a negative backlog rendered
 * as a fact is worse than no backlog line at all.
 */
function AuthorityArm({ coverage }: { coverage: BrainCoverage }) {
  const totals = coverage.authority.workspaceTotals;
  const hidden = hiddenBacklogSentence(coverage);
  return (
    <section className="space-y-4" aria-labelledby="coverage-authority-heading">
      <div>
        <h2 id="coverage-authority-heading" className="text-lg font-semibold">
          What has been observed, and where it stands
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every claim in this workspace, whoever it is granted to — not just the ones you can see in
          the review queue. Publishing is workspace-scoped, so this is the count the publish button
          acts on.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Awaiting review"
          value={totals.awaitingReview.toLocaleString()}
          icon={<Upload className="size-4" aria-hidden />}
          description="Drafts a human has not accepted yet. Nothing here is answered with."
        />
        <StatCard
          title="In tension"
          value={totals.inTension.toLocaleString()}
          icon={<Split className="size-4" aria-hidden />}
          description="Claims that disagree with another claim. Worth reviewing first."
        />
        <StatCard
          title="Provisional"
          value={totals.provisional.toLocaleString()}
          icon={<CircleDot className="size-4" aria-hidden />}
          description="Accepted, but resting on evidence Atlas rates as thin."
        />
        <StatCard
          title="Published"
          value={totals.published.toLocaleString()}
          icon={<Brain className="size-4" aria-hidden />}
          description="Reviewed and live — the agent may repeat these in answers."
        />
      </div>
      {hidden !== null && (
        <p className="text-sm text-muted-foreground" data-testid="coverage-hidden-backlog">
          {hidden}
        </p>
      )}
    </section>
  );
}

/**
 * The Slack ingest verdict (#5203) — read-only vitals for the source whose
 * install card the retirement removed.
 *
 * The one rule here: **a sync error renders as an error, in the sync's own
 * words.** The route's `sync.error` is written to be admin-actionable
 * ("reconnect Slack under Admin → Integrations…"), and this card is the only
 * console surface those words reach — dropping them would rebuild the
 * recorded-but-unread state this section exists to end.
 */
function SlackIngestCard({ vitals }: { vitals: SlackScopeVitals | null }) {
  if (!vitals) {
    // Same shape-guard reasoning as CoverageSurface: unreachable behind the
    // wrapper for this caller, and rendering fabricated vitals would be worse
    // than rendering none.
    return null;
  }
  const unhealthy = vitals.channels.filter((c) => c.health === "error").length;
  return (
    <Card className="mt-4 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Hash className="size-4" aria-hidden />
          Slack ingest
        </CardTitle>
        <CardDescription>
          {vitals.scopeMode === "legacy-pending"
            ? "This workspace's pre-existing channel scope has not been reconciled against the bot's membership yet — until then, the previously configured channel list is what Atlas reads."
            : "Atlas reads every channel the bot is a member of, minus any an admin excluded. Adding a channel is inviting the bot."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          {vitals.inScopeCount.toLocaleString()} channel{vitals.inScopeCount === 1 ? "" : "s"} in
          scope
          {unhealthy > 0 ? ` — ${unhealthy} failing the per-channel health check` : ""}
        </p>
        {vitals.sync === null ? (
          <p className="text-muted-foreground">
            No history sync recorded yet. If Slack is connected as a chat platform, the first cycle
            runs on its own — there is no second install to make.
          </p>
        ) : vitals.sync.status === "error" ? (
          <p className="flex items-start gap-2 font-medium text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{vitals.sync.error ?? "The last history sync failed."}</span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            Last history sync succeeded
            {vitals.sync.lastSyncAt
              ? ` (${new Date(vitals.sync.lastSyncAt).toLocaleString()})`
              : ""}
            {vitals.sync.coverageIncomplete
              ? " — the pass could not cover the whole scope and continues next cycle."
              : "."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Link card into one of the group's curation surfaces. */
function SurfaceCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Card className="shadow-none transition-colors hover:bg-muted/40">
      <Link href={href} className="block">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            {title}
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Link>
    </Card>
  );
}
