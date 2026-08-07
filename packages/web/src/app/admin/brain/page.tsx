"use client";

import Link from "next/link";
import type { z } from "zod";
import { ArrowRight, Brain, CircleDot, Split, Upload } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { BrainFactCandidateSummarySchema } from "@/ui/lib/admin-schemas";

type BrainSummary = z.infer<typeof BrainFactCandidateSummarySchema>;

/**
 * Landing page for the Company Atlas group (#5066).
 *
 * ## Why this page exists at all
 *
 * The brain is not a pillar — it owns no catalog row of its own. It is a layer
 * DERIVED from episodes (Slack history, Zoom transcripts, Outlook mail),
 * authoritative for its class and yielding to the warehouse Datasource
 * wherever the two overlap. That makes it orthogonal to all four
 * pillars rather than a fifth one, and the sidebar should read that way: its
 * own group, with this as the landing page and every curation surface
 * underneath. The taxonomy argument lives in CONTEXT.md under "Company Atlas";
 * ADR-0036 holds the substrate design.
 *
 * Note the asymmetry the copy below has to respect: the brain's ingest sources
 * ARE installable knowledge-pillar catalog rows, but a knowledge DOCUMENT is
 * never extracted into a fact — the extraction cycle drains `brain_episodes`
 * alone. "Atlas learns from your knowledge base" is the inversion to avoid.
 *
 * ## What it is NOT
 *
 * Not a second review queue. `/admin/brain/facts` owns reviewing, rejecting
 * and publishing; the numbers here are read-only signposts into it. Adding an
 * action to this page would make `brain_facts.status` writable from two
 * surfaces, which is the same mistake the facts page documents at length in
 * its "no per-row Approve button" note. `read-only-vitals.test.tsx` pins that
 * structurally — it fails the render if any endpoint outside `GET /summary`
 * is touched.
 *
 * ## Why the counts go through AdminContentWrapper rather than an ErrorBanner
 *
 * Every number here is a BACKLOG, so a failed read that rendered as `0` would
 * say "your queue is clear" at the exact moment nobody knows what is in it.
 * The wrapper is what keeps that honest *and* correctly typed: `/summary`
 * answers 404 when the internal database isn't configured — the ordinary
 * self-hosted state, not a fault — and 403 + `mfa_enrollment_required` behind
 * the enrollment dialog. A hand-rolled `<ErrorBanner message={friendlyError(…)}>`
 * flattens the structured error into a string and loses that routing — the 404
 * arm keys on `FetchError.status`, the MFA/enterprise arms on `.code` — greeting
 * a self-hosted operator with a red alert and a Retry button that cannot help.
 */
export default function CompanyBrainOverview() {
  const {
    data: summary,
    loading,
    error,
    refetch,
  } = useAdminFetch<BrainSummary>("/api/v1/admin/brain-facts/summary", {
    schema: BrainFactCandidateSummarySchema,
  });

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Company Atlas</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          What Atlas has learned about your business from the conversations it can see —
          claims pulled out of chat history, meeting transcripts and mail, held behind a review
          gate until a human accepts them. It never overrides your warehouse: where a learned
          fact and your data disagree, the data wins.
        </p>
      </div>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Company Atlas"
          onRetry={refetch}
          loadingMessage="Loading Company Atlas vitals..."
        >
          <SummaryGrid summary={summary} />
        </AdminContentWrapper>
      </ErrorBoundary>

      {/* Deliberately OUTSIDE the wrapper. The wrapper replaces its children
          wholesale on error, and this card is the page's only in-content route
          into the review queue — a workspace whose summary won't load is
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

/** The four backlog counts. Rendered only once the wrapper has cleared loading and error. */
function SummaryGrid({ summary }: { summary: BrainSummary | null }) {
  if (!summary) {
    // Unreachable for THIS caller: `loading` stays true until data or error
    // exists, and the schema makes all four counts required, so the wrapper has
    // already returned by now. (`useAdminFetch` CAN yield `loading: false,
    // data: null` under `enabled: false` — this page passes no `enabled`.)
    // Guarded for the SHAPE: `?? 0` would print a cleared backlog nobody
    // measured, and `return null` would leave a silent hole where four numbers
    // belong.
    console.warn(
      "brain overview: SummaryGrid received summary=null, which AdminContentWrapper's " +
        "contract makes unreachable (/api/v1/admin/brain-facts/summary) — rendering no " +
        "counts rather than zeros that would read as an empty queue",
    );
    return (
      <p className="text-sm text-muted-foreground">
        The backlog counts are unavailable. Open Facts below to review the queue directly.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Awaiting review"
        value={summary.draftTotal.toLocaleString()}
        icon={<Upload className="size-4" aria-hidden />}
        description="Drafts a human has not accepted yet. Nothing here is answered with."
      />
      <StatCard
        title="In tension"
        value={summary.inTensionTotal.toLocaleString()}
        icon={<Split className="size-4" aria-hidden />}
        description="Claims that disagree with another claim. Worth reviewing first."
      />
      <StatCard
        title="Provisional"
        value={summary.provisionalTotal.toLocaleString()}
        icon={<CircleDot className="size-4" aria-hidden />}
        description="Accepted, but resting on evidence Atlas rates as thin."
      />
      <StatCard
        title="Published"
        value={summary.publishedTotal.toLocaleString()}
        icon={<Brain className="size-4" aria-hidden />}
        description="Reviewed and live — the agent may repeat these in answers."
      />
    </div>
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
