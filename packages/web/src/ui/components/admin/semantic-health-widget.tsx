"use client";

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Activity, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface SemanticHealthScore {
  overall: number;
  coverage: number;
  descriptionQuality: number;
  measureCoverage: number;
  joinCoverage: number;
  entityCount: number;
  dimensionCount: number;
  measureCount: number;
  glossaryTermCount: number;
  // #4514 — the status discriminator. A zero from parse failure ("corrupt") is
  // an actionable "fix the YAML" signal; a no-data zero ("no_entities") is
  // "build the layer". `status` is optional so an older API response (pre-#4514)
  // that omits it degrades to the plain score view rather than crashing.
  // These literals mirror the api-side `SEMANTIC_HEALTH_STATUSES` tuple
  // (lib/semantic/expert/briefing.ts) — @atlas/web can't import @atlas/api, so
  // this copy is kept in lockstep by hand (the wire contract, not a shared type).
  status?: "ok" | "no_entities" | "corrupt";
  parseFailures?: number;
  totalRows?: number;
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-600 dark:text-green-400";
  if (score >= 40) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function scoreBg(score: number): string {
  if (score >= 70) return "bg-green-100 dark:bg-green-900/30";
  if (score >= 40) return "bg-yellow-100 dark:bg-yellow-900/30";
  return "bg-red-100 dark:bg-red-900/30";
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium ${scoreColor(value)}`}>{value}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full transition-all ${
            value >= 70 ? "bg-green-500" : value >= 40 ? "bg-yellow-500" : "bg-red-500"
          }`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function SemanticHealthWidget() {
  const { data: score, loading, error, refetch } = useAdminFetch<SemanticHealthScore>(
    "/api/v1/admin/semantic-improve/health",
  );

  if (loading) return null;

  if (error || !score) {
    return (
      <Card className="mx-6 mb-4 shadow-none">
        <CardContent className="flex items-center justify-between py-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Activity className="size-4" />
            Could not load semantic health score.
          </span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-6 mb-4 shadow-none">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="size-4" />
            Semantic Layer Health
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`${scoreColor(score.overall)} ${scoreBg(score.overall)} border-0 font-bold`}
            >
              {score.overall}%
            </Badge>
            <Link href="/admin/semantic/improve">
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                <Sparkles className="size-3" />
                Improve
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* #4514 — distinguish a parse-failure zero from a no-data zero. A
            corrupt layer needs the malformed YAML fixed; an empty layer needs
            entities built. Conflating both as "0% coverage" gave no actionable
            signal. */}
        {score.status === "corrupt" ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="size-3.5 shrink-0" />
            {score.parseFailures ?? 0} of {score.totalRows ?? 0}{" "}
            {(score.totalRows ?? 0) === 1 ? "entity" : "entities"} failed to parse — fix the
            malformed YAML.
          </p>
        ) : score.status === "no_entities" ? (
          <p className="text-xs text-muted-foreground">
            No entities yet — build the semantic layer to start scoring it.
          </p>
        ) : (
          <>
            <ScoreBar label="Coverage" value={score.coverage} />
            <ScoreBar label="Descriptions" value={score.descriptionQuality} />
            <ScoreBar label="Measures" value={score.measureCoverage} />
            <ScoreBar label="Joins" value={score.joinCoverage} />
          </>
        )}
        <div className="flex gap-3 pt-1 text-[10px] text-muted-foreground">
          <span>{score.entityCount} entities</span>
          <span>{score.dimensionCount} dimensions</span>
          <span>{score.measureCount} measures</span>
          <span>{score.glossaryTermCount} terms</span>
        </div>
      </CardContent>
    </Card>
  );
}
