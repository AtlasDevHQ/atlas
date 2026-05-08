"use client";

/**
 * Settings → AI Agents — "Prompts your agent will see" preview (#2179).
 *
 * The `/api/v1/me/mcp-prompts` endpoint returns the same list the user's
 * connected agent gets via MCP `prompts/list`, plus a structured gate
 * envelope explaining a hidden canonical-prompts source. This component
 * groups by source for quick glanceability ("Built-in 5 · Canonical 20
 * · Semantic 12 · Library 3"), shows the first 3 example names per
 * group, and offers a "View all" expander that reveals the full set
 * without leaving the page.
 *
 * Gate banner: when `canonicalGate.exposed === false`, the closed-gate
 * reason becomes a one-line banner at the top of the section with a
 * deep-link to Admin → Settings → MCP. The reason key drives the copy
 * so a future "internal-db-unavailable" branch can land without a
 * touchpoint here.
 */

import Link from "next/link";
import { useState } from "react";
import { Sparkles, BookOpen, Database, Library, ChevronDown, AlertCircle } from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  McpPromptsResponseSchema,
  type McpPromptListEntry,
  type McpPromptSource,
  type McpCanonicalGate,
} from "@/ui/lib/me-schemas";
import { SectionHeading } from "@/ui/components/admin/compact";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const SOURCE_PREVIEW_LIMIT = 3;

// Single source-of-truth map for source labels + icons. Adding a future
// source still requires updates to `SOURCE_ORDER` (render order) and to
// the `groupBySource` init record — TypeScript exhaustiveness on
// `Record<McpPromptSource, …>` will flag the misses, so the change-set
// is type-checked rather than guessed.
const SOURCE_META: Record<McpPromptSource, { label: string; icon: typeof Sparkles; description: string }> = {
  builtin: {
    label: "Built-in",
    icon: Sparkles,
    description: "Always-on analytical templates",
  },
  canonical: {
    label: "Canonical",
    icon: BookOpen,
    description: "Eval-suite questions for demo workspaces",
  },
  semantic: {
    label: "Semantic",
    icon: Database,
    description: "Query patterns from your entity YAMLs",
  },
  library: {
    label: "Library",
    icon: Library,
    description: "Admin-curated prompt collections",
  },
};

// Render order in the UI — mirrors the listing pipeline order so the
// preview reflects what an agent's prompt picker shows top-down.
const SOURCE_ORDER: ReadonlyArray<McpPromptSource> = [
  "builtin",
  "canonical",
  "semantic",
  "library",
];

export function PromptsPreview() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/me/mcp-prompts",
    { schema: McpPromptsResponseSchema },
  );

  return (
    <section className="mt-10" data-testid="prompts-preview">
      <SectionHeading
        title="Prompts your agent will see"
        description={
          data
            ? `${data.prompts.length} prompt${data.prompts.length === 1 ? "" : "s"} grouped by source. Counts match the prompts/list response your connected agent receives.`
            : "Counts match the prompts/list response your connected agent receives."
        }
      />
      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="AI Agents"
          onRetry={refetch}
          loadingMessage="Loading prompt preview…"
        >
          {data ? <PromptsPreviewContent data={data} /> : null}
        </AdminContentWrapper>
      </ErrorBoundary>
    </section>
  );
}

function PromptsPreviewContent({
  data,
}: {
  data: { prompts: ReadonlyArray<McpPromptListEntry>; canonicalGate: McpCanonicalGate };
}) {
  const [showAll, setShowAll] = useState(false);
  const grouped = groupBySource(data.prompts);
  const totalVisible = data.prompts.length;

  return (
    <>
      {!data.canonicalGate.exposed && (
        <CanonicalGateBanner gate={data.canonicalGate} />
      )}

      <div className="space-y-3">
        {SOURCE_ORDER.map((source) => {
          const entries = grouped[source];
          if (entries.length === 0) return null;
          return (
            <SourceGroup
              key={source}
              source={source}
              entries={entries}
              expanded={showAll}
            />
          );
        })}
      </div>

      {totalVisible > SOURCE_PREVIEW_LIMIT * SOURCE_ORDER.length && (
        <div className="mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            data-testid="prompts-preview-toggle"
          >
            <ChevronDown
              className={cn(
                "mr-1.5 size-3.5 transition-transform",
                showAll && "rotate-180",
              )}
            />
            {showAll ? "Show less" : "View all prompts"}
          </Button>
        </div>
      )}
    </>
  );
}

function groupBySource(
  prompts: ReadonlyArray<McpPromptListEntry>,
): Record<McpPromptSource, McpPromptListEntry[]> {
  const init: Record<McpPromptSource, McpPromptListEntry[]> = {
    builtin: [],
    canonical: [],
    semantic: [],
    library: [],
  };
  for (const p of prompts) init[p.source].push(p);
  return init;
}

function SourceGroup({
  source,
  entries,
  expanded,
}: {
  source: McpPromptSource;
  entries: ReadonlyArray<McpPromptListEntry>;
  expanded: boolean;
}) {
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  const visibleEntries = expanded
    ? entries
    : entries.slice(0, SOURCE_PREVIEW_LIMIT);
  const hidden = entries.length - visibleEntries.length;

  return (
    <Collapsible
      open
      data-testid={`prompts-preview-source-${source}`}
      className="rounded-lg border border-border/60 bg-card/40 px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium">{meta.label}</span>
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {entries.length}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">{meta.description}</span>
      </div>
      <CollapsibleContent className="mt-2 space-y-1">
        <ul className="space-y-1 font-mono text-xs text-muted-foreground">
          {visibleEntries.map((entry) => (
            <li key={entry.name} className="truncate">
              <span className="text-foreground/80">{entry.name}</span>
              {entry.description && (
                <span className="ml-2 opacity-70">— {entry.description}</span>
              )}
            </li>
          ))}
        </ul>
        {!expanded && hidden > 0 && (
          <p className="text-[11px] text-muted-foreground">
            +{hidden} more
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CanonicalGateBanner({ gate }: { gate: McpCanonicalGate }) {
  const { reason, toggle } = gate;
  // Reason key → banner copy. `signal-unavailable` is the operator-
  // facing outage signal: the connections probe failed AND no industry
  // signal could confirm demo status — the user-actionable advice
  // ("retry / contact support") differs from "this isn't a demo
  // workspace," so the two reasons render distinct copy. `null` is
  // unreachable when `exposed=false` for current API shapes, but we
  // include a defensive fallback for the multi-PR-rollout scenario
  // where a future reason key lands in the API before this page is
  // updated (the schema's `.catch(null)` keeps the response parseable
  // and steers unknown values into this generic banner).
  const copy = (() => {
    switch (reason) {
      case "toggle-never":
        return {
          title: "Canonical eval prompts are turned off",
          body: "An admin disabled the canonical NovaMart eval prompts at Admin → Settings → MCP. Your agent won't see them in prompts/list.",
        };
      case "no-demo-signal":
        return {
          title: "Canonical eval prompts are auto-detected",
          body: `Atlas only surfaces canonical eval prompts to demo workspaces (toggle is "${toggle}"). Switch to "always" in Admin → Settings → MCP if you want them in prompts/list anyway.`,
        };
      case "signal-unavailable":
        return {
          title: "Couldn't check canonical-prompts gate",
          body: "Atlas tried to detect demo-workspace status but the internal-DB probe failed. Try refreshing — if the issue persists, open Admin → Settings → MCP to set the toggle explicitly or contact support.",
        };
      case null:
      default:
        return {
          title: "Canonical eval prompts are hidden",
          body: "Visit Admin → Settings → MCP to manage the canonical-prompts toggle.",
        };
    }
  })();

  return (
    <Alert
      variant="default"
      className="mb-4 border-amber-500/40 bg-amber-500/5"
      data-testid="canonical-gate-banner"
    >
      <AlertCircle className="size-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
      <AlertTitle className="text-sm">{copy.title}</AlertTitle>
      <AlertDescription className="text-xs">
        {copy.body}{" "}
        <Link
          href="/admin/settings/mcp"
          className="font-medium underline underline-offset-2"
        >
          Open MCP settings
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
