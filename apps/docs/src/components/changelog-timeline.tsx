"use client";

import { ExternalLink, GitBranch } from "lucide-react";
import type { Release } from "./changelog-data";
import { releases } from "./changelog-data";

// ── Helpers ────────────────────────────────────────────────

function milestoneUrl(r: Release) {
  if (!r.githubMilestone) return undefined;
  return `https://github.com/AtlasDevHQ/atlas/milestone/${r.githubMilestone}`;
}

// ── Single release card ───────────────────────────────────

function ReleaseCard({
  release,
  isLatest,
}: {
  release: Release;
  isLatest: boolean;
}) {
  const url = milestoneUrl(release);

  return (
    <div
      className={`group relative rounded-lg border transition-colors ${
        isLatest
          ? "border-[var(--color-fd-primary)]/40 bg-[var(--color-fd-primary)]/[0.04]"
          : "border-[var(--color-fd-border)] bg-[var(--color-fd-card)]"
      } px-5 py-4`}
    >
      {/* Version + Title + Date row */}
      <div className="flex items-baseline gap-3">
        <code
          className={`shrink-0 text-xs font-medium ${
            isLatest
              ? "text-[var(--color-fd-primary)]"
              : "text-[var(--color-fd-muted-foreground)]"
          }`}
        >
          {release.version}
        </code>
        <h3 className="font-medium leading-snug text-base text-[var(--color-fd-foreground)]">
          {release.title}
        </h3>
        {release.date && (
          <span className="ml-auto shrink-0 text-xs text-[var(--color-fd-muted-foreground)]/60">
            {release.date}
          </span>
        )}
      </div>

      {/* Summary */}
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fd-muted-foreground)]">
        {release.summary}
      </p>

      {/* Highlights */}
      {release.highlights && release.highlights.length > 0 && (
        <ul className="mt-3 space-y-1">
          {release.highlights.map((h) => (
            <li
              key={h}
              className="flex items-start gap-2 text-sm text-[var(--color-fd-muted-foreground)]"
            >
              <span
                className={`mt-2 h-1 w-1 shrink-0 rounded-full ${
                  isLatest
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
      {url && (
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

// ── Footer ─────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="mt-12 border-t border-[var(--color-fd-border)] pt-6">
      <div className="flex flex-wrap gap-4">
        <a
          href="https://github.com/AtlasDevHQ/atlas/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          GitHub Releases
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <a
          href="https://github.com/AtlasDevHQ/atlas/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          GitHub Issues
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
      <p className="mt-3 text-xs text-[var(--color-fd-muted-foreground)]/60">
        File feature requests or bug reports on GitHub Issues.
      </p>
    </footer>
  );
}

// ── Main export ────────────────────────────────────────────

export function ChangelogTimeline() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="relative space-y-4 pl-8">
        {/* Timeline line */}
        <div className="absolute left-[11px] top-0 bottom-0 w-px bg-[var(--color-fd-border)]" />

        {releases.map((r, i) => (
          <div key={`${r.version}-${r.title}`} className="relative">
            {/* Dot */}
            <div className="absolute -left-8 top-4">
              <div
                className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                  i === 0
                    ? "border-[var(--color-fd-primary)]/40 bg-[var(--color-fd-primary)]/10"
                    : "border-[var(--color-fd-muted-foreground)]/30 bg-[var(--color-fd-background)]"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    i === 0
                      ? "bg-[var(--color-fd-primary)]"
                      : "bg-[var(--color-fd-muted-foreground)]/40"
                  }`}
                />
              </div>
            </div>
            <ReleaseCard release={r} isLatest={i === 0} />
          </div>
        ))}
      </div>
      <Footer />
    </div>
  );
}
