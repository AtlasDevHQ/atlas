"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  BookOpen,
  Settings,
  Database,
  CircleHelp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTourContext } from "./guided-tour";

interface NavBarProps {
  /** Whether the current user has admin role. */
  isAdmin: boolean;
}

const navItems = [
  { href: "/", label: "Chat", icon: MessageSquare, tourId: "chat" },
  { href: "/notebook", label: "Notebook", icon: BookOpen, tourId: "notebook" },
] as const;

const adminItems = [
  { href: "/admin", label: "Admin", icon: Settings, tourId: "admin" },
  { href: "/admin/semantic", label: "Semantic", icon: Database, tourId: "semantic" },
] as const;

/**
 * Top navigation bar with data-tour attributes for the guided tour.
 *
 * Renders navigation links for Chat, Notebook, Admin (admin only),
 * and Semantic Layer. Includes a help menu with a "Replay tour" option.
 */
export function NavBar({ isAdmin }: NavBarProps) {
  const pathname = usePathname();
  const tourContext = useTourContext();

  const allItems = isAdmin
    ? [...navItems, ...adminItems]
    : [...navItems, { href: "/admin/semantic" as const, label: "Semantic" as const, icon: Database, tourId: "semantic" as const }];

  return (
    <nav className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-1">
        {allItems.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              data-tour={item.tourId}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300",
              )}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{item.label}</span>
            </Link>
          );
        })}
      </div>

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
    </nav>
  );
}
