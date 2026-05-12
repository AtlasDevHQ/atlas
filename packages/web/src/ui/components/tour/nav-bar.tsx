"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  BookOpen,
  LayoutDashboard,
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
import { OrgSwitcher } from "@/ui/components/org-switcher";
import { UserMenu } from "@/ui/components/user-menu";

interface NavBarProps {
  /** Whether the current user has admin role. */
  isAdmin: boolean;
}

const navItems = [
  { href: "/", label: "Chat", icon: MessageSquare, tourId: "chat" },
  { href: "/notebook", label: "Notebook", icon: BookOpen, tourId: "notebook" },
  { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard, tourId: "dashboards" },
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
    <nav className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
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
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary dark:bg-primary/15"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
              )}
            >
              <Icon className="size-4" />
              <span className="hidden sm:inline">{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <OrgSwitcher variant="inline" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              aria-label="Help menu"
            >
              <CircleHelp className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <a
                href="https://docs.useatlas.dev"
                target="_blank"
                rel="noreferrer"
              >
                Documentation
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                window.dispatchEvent(new CustomEvent("atlas:open-shortcuts"));
              }}
            >
              <span className="flex-1">Keyboard shortcuts</span>
              <kbd className="ml-2 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                ?
              </kbd>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => tourContext?.startTour()}
              disabled={!tourContext}
            >
              Replay guided tour
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <UserMenu />
      </div>
    </nav>
  );
}
