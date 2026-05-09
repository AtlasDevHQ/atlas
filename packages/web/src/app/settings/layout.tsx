"use client";

/**
 * `/settings/*` shell.
 *
 * `/settings/profile`, `/settings/ai-agents`, etc. are user-scoped and
 * intentionally outside the heavy admin sidebar. They still need chrome —
 * a back-link affordance + the same avatar dropdown — so the page isn't a
 * navigation dead-end after the user opens it from chat or admin.
 *
 * Mirrors the admin top-bar pattern (#2176): logo → settings breadcrumb →
 * avatar menu on the right. Lighter than the admin shell on purpose; this
 * is a focused-task surface, not a workspace control panel.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { UserMenu } from "@/ui/components/user-menu";

const SECTION_LABELS: Record<string, string> = {
  profile: "Profile",
  "ai-agents": "AI Agents",
};

function pageLabelFor(pathname: string): string | null {
  // Pathname looks like `/settings/<page>` or `/settings/<page>/<sub>` —
  // resolve only the first segment under /settings to a label and let
  // anything deeper render as the literal segment (humanized below).
  const match = pathname.match(/^\/settings\/([^/]+)/);
  if (!match) return null;
  const segment = match[1];
  if (segment in SECTION_LABELS) return SECTION_LABELS[segment];
  // Fallback: humanize "kebab-case" → "Title Case" so unmapped pages still
  // render a recognizable crumb without forcing every new settings route
  // to update this file in lockstep.
  return segment
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pageLabel = pageLabelFor(pathname);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            href="/"
            aria-label="Atlas home"
            className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
          >
            <svg viewBox="0 0 256 256" fill="none" className="size-4" aria-hidden="true">
              <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="20" fill="none" strokeLinejoin="round" />
            </svg>
          </Link>
          <Separator orientation="vertical" className="mr-1 h-4" />
          {/*
            "Settings" is a non-link root because there's no /settings
            index page to navigate to. The home logo on the left and the
            avatar dropdown on the right are the back-navigation
            affordances.
          */}
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem className="shrink-0">
                <span className="text-sm text-muted-foreground">Settings</span>
              </BreadcrumbItem>
              {pageLabel && (
                <>
                  <BreadcrumbSeparator className="shrink-0" />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="block max-w-[10rem] truncate sm:max-w-[16rem]">
                      {pageLabel}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <UserMenu />
      </header>

      <main id="main" tabIndex={-1} className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
