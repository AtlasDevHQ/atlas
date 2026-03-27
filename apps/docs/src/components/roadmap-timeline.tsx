"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  ExternalLink,
  GitBranch,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "./roadmap-data";
import { milestones } from "./roadmap-data";

// ── Helpers ────────────────────────────────────────────────

const shipped = milestones.filter((m) => m.status === "shipped");
const current = milestones.filter((m) => m.status === "current");
const planned = milestones.filter((m) => m.status === "planned");

function milestoneUrl(m: Milestone) {
  if (!m.githubMilestone) return undefined;
  return `https://github.com/AtlasDevHQ/atlas/milestone/${m.githubMilestone}`;
}

function versionLabel(m: Milestone) {
  return m.version === "pre" ? "pre-release" : m.version;
}

// ── Status dot on the timeline ─────────────────────────────

function TimelineDot({ status }: { status: MilestoneStatus }) {
  if (status === "shipped") {
    return (
      <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-[var(--color-fd-muted-foreground)]/30 bg-[var(--color-fd-background)]">
        <Check
          className="h-3 w-3 text-[var(--color-fd-muted-foreground)]"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </div>
    );
  }

  if (status === "current") {
    return (
      <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center">
        {/* Pulse ring */}
        <span className="absolute h-6 w-6 animate-ping rounded-full bg-[var(--color-fd-primary)] opacity-20" />
        <span className="relative h-3 w-3 rounded-full bg-[var(--color-fd-primary)]" />
      </div>
    );
  }

  // planned
  return (
    <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center">
      <Circle
        className="h-3.5 w-3.5 text-[var(--color-fd-muted-foreground)]/50"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </div>
  );
}

// ── Single milestone card ──────────────────────────────────

function MilestoneCard({
  milestone,
  compact = false,
}: {
  milestone: Milestone;
  compact?: boolean;
}) {
  const url = milestoneUrl(milestone);

  return (
    <div
      className={`group relative rounded-lg border transition-colors ${
        milestone.status === "current"
          ? "border-[var(--color-fd-primary)]/40 bg-[var(--color-fd-primary)]/[0.04]"
          : "border-[var(--color-fd-border)] bg-[var(--color-fd-card)]"
      } ${compact ? "px-4 py-3" : "px-5 py-4"}`}
    >
      {/* Version + Title row */}
      <div className="flex items-baseline gap-3">
        <code
          className={`shrink-0 text-xs font-medium ${
            milestone.status === "current"
              ? "text-[var(--color-fd-primary)]"
              : "text-[var(--color-fd-muted-foreground)]"
          }`}
        >
          {versionLabel(milestone)}
        </code>
        <h3
          className={`font-medium leading-snug ${
            compact ? "text-sm" : "text-base"
          } text-[var(--color-fd-foreground)]`}
        >
          {milestone.title}
        </h3>
      </div>

      {/* Summary */}
      <p
        className={`mt-1.5 leading-relaxed text-[var(--color-fd-muted-foreground)] ${
          compact ? "text-xs" : "text-sm"
        }`}
      >
        {milestone.summary}
      </p>

      {/* Highlights (non-compact only) */}
      {!compact && milestone.highlights && milestone.highlights.length > 0 && (
        <ul className="mt-3 space-y-1">
          {milestone.highlights.map((h) => (
            <li
              key={h}
              className="flex items-start gap-2 text-sm text-[var(--color-fd-muted-foreground)]"
            >
              <span
                className={`mt-2 h-1 w-1 shrink-0 rounded-full ${
                  milestone.status === "current"
                    ? "bg-[var(--color-fd-primary)]"
                    : "bg-[var(--color-fd-muted-foreground)]/40"
                }`}
              />
              {h}
            </li>
          ))}
        </ul>
      )}

      {/* GitHub link */}
      {url && !compact && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          <GitBranch className="h-3 w-3" aria-hidden="true" />
          GitHub Milestone
          <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

// ── Shipped section (collapsible) ──────────────────────────

function ShippedSection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <section aria-label="Shipped milestones">
      {/* Section header + toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="group mb-4 flex w-full cursor-pointer items-center gap-3 text-left"
        aria-expanded={expanded}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-fd-muted-foreground)]/10">
          <Check
            className="h-3 w-3 text-[var(--color-fd-muted-foreground)]"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </div>
        <span className="text-sm font-medium text-[var(--color-fd-foreground)]">
          {shipped.length} milestones shipped
        </span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--color-fd-muted-foreground)] transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {/* Collapsible content — grid-row trick for smooth height */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative pb-6 pl-8">
            {/* Timeline line */}
            <div className="absolute left-[11px] top-0 bottom-0 w-px bg-[var(--color-fd-border)]" />

            <div className="space-y-3">
              {shipped.map((m, i) => (
                <div key={`${m.version}-${m.title}`} className="relative">
                  {/* Dot */}
                  <div className="absolute -left-8 top-3">
                    <TimelineDot status="shipped" />
                  </div>
                  <MilestoneCard milestone={m} compact />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Active section ─────────────────────────────────────────

function CurrentSection() {
  if (current.length === 0) return null;

  return (
    <section aria-label="In progress" className="relative pl-8">
      {/* Timeline line — brand color */}
      <div className="absolute left-[11px] top-0 bottom-0 w-px bg-[var(--color-fd-primary)]/30" />

      {/* Section label */}
      <p className="mb-4 text-xs font-semibold tracking-widest text-[var(--color-fd-primary)] uppercase">
        In progress
      </p>

      <div className="space-y-4">
        {current.map((m) => (
          <div key={`${m.version}-${m.title}`} className="relative">
            <div className="absolute -left-8 top-4">
              <TimelineDot status="current" />
            </div>
            <MilestoneCard milestone={m} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Planned section ────────────────────────────────────────

function PlannedSection() {
  if (planned.length === 0) return null;

  return (
    <section aria-label="Planned milestones" className="relative pl-8">
      {/* Timeline line — dashed for upcoming */}
      <div
        className="absolute left-[11px] top-0 bottom-0 w-px"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, var(--color-fd-border) 0, var(--color-fd-border) 4px, transparent 4px, transparent 10px)",
        }}
      />

      {/* Section label */}
      <p className="mb-4 text-xs font-semibold tracking-widest text-[var(--color-fd-muted-foreground)] uppercase">
        Planned
      </p>

      <div className="space-y-4">
        {planned.map((m) => (
          <div key={`${m.version}-${m.title}`} className="relative">
            <div className="absolute -left-8 top-4">
              <TimelineDot status="planned" />
            </div>
            <MilestoneCard milestone={m} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────

function LiveTracking() {
  return (
    <footer className="mt-12 border-t border-[var(--color-fd-border)] pt-6">
      <p className="mb-3 text-xs font-semibold tracking-widest text-[var(--color-fd-muted-foreground)] uppercase">
        Live tracking
      </p>
      <div className="flex flex-wrap gap-4">
        <a
          href="https://github.com/AtlasDevHQ/atlas/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          GitHub Issues
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <a
          href="https://github.com/AtlasDevHQ/atlas/milestones"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          Milestones
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
      <p className="mt-3 text-xs text-[var(--color-fd-muted-foreground)]/60">
        Atlas uses public semver starting at 0.0.x. File feature requests or bug
        reports on GitHub Issues.
      </p>
    </footer>
  );
}

// ── Main export ────────────────────────────────────────────

export function RoadmapTimeline() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="space-y-8">
        <ShippedSection />
        <CurrentSection />
        <PlannedSection />
      </div>
      <LiveTracking />
    </div>
  );
}
