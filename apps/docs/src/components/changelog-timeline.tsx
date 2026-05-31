"use client";

import { ExternalLink, GitBranch, Tag } from "lucide-react";
import type { Release } from "./changelog-data";
import { developmentHistory, releases } from "./changelog-data";

// ── Helpers ────────────────────────────────────────────────

const REPO = "https://github.com/AtlasDevHQ/atlas";

/** Tag-train entries are versioned `v0.0.1`, `v0.1.0`, …; history entries are `1.6.0`, `0.9`. */
function isTagRelease(r: Release) {
  return /^v\d/.test(r.version);
}

/**
 * Tag releases link to their GitHub Release; pre-versioning history entries link to the
 * milestone that tracked the work (when one exists).
 */
function externalLinkFor(r: Release): { href: string; label: string } | undefined {
  if (isTagRelease(r)) {
    return { href: `${REPO}/releases/tag/${r.version}`, label: "GitHub Release" };
  }
  if (r.githubMilestone) {
    return { href: `${REPO}/milestone/${r.githubMilestone}`, label: "GitHub Milestone" };
  }
  return undefined;
}

// ── Single release card ───────────────────────────────────

function ReleaseCard({
  release,
  isLatest,
}: {
  release: Release;
  isLatest: boolean;
}) {
  const link = externalLinkFor(release);
  const LinkIcon = isTagRelease(release) ? Tag : GitBranch;

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
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fd-muted-foreground)] transition-colors hover:text-[var(--color-fd-primary)]"
        >
          <LinkIcon className="h-3 w-3" aria-hidden="true" />
          {link.label}
          <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

// ── Timeline track (one column of cards) ──────────────────

function Track({
  items,
  latestIndex,
}: {
  items: Release[];
  /** Index within `items` to render as "latest", or -1 for none. */
  latestIndex: number;
}) {
  return (
    <div className="relative space-y-4 pl-8">
      {/* Timeline line */}
      <div className="absolute left-[11px] top-0 bottom-0 w-px bg-[var(--color-fd-border)]" />

      {items.map((r, i) => (
        <div key={`${r.version}-${r.title}`} className="relative">
          {/* Dot */}
          <div className="absolute -left-8 top-4">
            <div
              className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                i === latestIndex
                  ? "border-[var(--color-fd-primary)]/40 bg-[var(--color-fd-primary)]/10"
                  : "border-[var(--color-fd-muted-foreground)]/30 bg-[var(--color-fd-background)]"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  i === latestIndex
                    ? "bg-[var(--color-fd-primary)]"
                    : "bg-[var(--color-fd-muted-foreground)]/40"
                }`}
              />
            </div>
          </div>
          <ReleaseCard release={r} isLatest={i === latestIndex} />
        </div>
      ))}
    </div>
  );
}

// ── Development-history divider ────────────────────────────

function HistoryDivider() {
  return (
    <div className="mt-10 mb-4">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--color-fd-border)]" />
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--color-fd-muted-foreground)]/70">
          Development history
        </span>
        <div className="h-px flex-1 bg-[var(--color-fd-border)]" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[var(--color-fd-muted-foreground)]/70">
        Internal milestone numbers from before Atlas adopted public version tags. These predate the{" "}
        <code>v0.0.x</code> release train above and are kept as a record of what shipped during
        development — they are not public semver.
      </p>
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
      {/* Public git-tag train — newest first; first entry is the latest release. */}
      <Track items={releases} latestIndex={0} />

      {/* Pre-public-versioning development history. */}
      {developmentHistory.length > 0 && (
        <>
          <HistoryDivider />
          <Track items={developmentHistory} latestIndex={-1} />
        </>
      )}

      <Footer />
    </div>
  );
}
