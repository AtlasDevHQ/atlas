"use client";

/**
 * Minimal top bar for the chat-first front door (#2022).
 *
 * Strips the cross-section nav (Notebook / Dashboards / Admin / Semantic) the
 * pre-1.4.3 NavBar surfaced at `/` — those links read as admin chrome to a
 * new self-hosted user and were the "first impression is Workday, not agent"
 * gap. The chat surface is the product; everything else is reachable through
 * the avatar menu or the settings gear.
 *
 * Notebook / Dashboards / etc. keep the older `<NavBar>` because they ARE
 * cross-section pages — this component is intentionally chat-only.
 */

import Link from "next/link";
import { Settings, CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OrgSwitcher } from "@/ui/components/org-switcher";
import { UserMenu } from "@/ui/components/user-menu";
import { useTourContext } from "@/ui/components/tour/guided-tour";

interface ChatTopBarProps {
  /** Whether the calling user has admin role — gates the gear icon. */
  isAdmin: boolean;
}

export function ChatTopBar({ isAdmin }: ChatTopBarProps) {
  const tourContext = useTourContext();

  return (
    <nav className="flex h-10 shrink-0 items-center justify-end gap-2 border-b border-zinc-200 bg-zinc-50 px-4 dark:border-zinc-800 dark:bg-zinc-950">
      <OrgSwitcher variant="inline" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
            aria-label="Help menu"
          >
            <CircleHelp className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => tourContext?.startTour()}
            disabled={!tourContext}
          >
            Replay guided tour
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <Button
          asChild
          variant="ghost"
          size="icon-xs"
          className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          <Link href="/admin" aria-label="Open admin console" data-tour="admin">
            <Settings className="size-4" />
          </Link>
        </Button>
      )}
      <UserMenu />
    </nav>
  );
}
