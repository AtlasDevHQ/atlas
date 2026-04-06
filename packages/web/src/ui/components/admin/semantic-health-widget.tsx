"use client";

import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Activity } from "lucide-react";
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
        <ScoreBar label="Coverage" value={score.coverage} />
        <ScoreBar label="Descriptions" value={score.descriptionQuality} />
        <ScoreBar label="Measures" value={score.measureCoverage} />
        <ScoreBar label="Joins" value={score.joinCoverage} />
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
