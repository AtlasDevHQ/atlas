"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ArrowRight } from "lucide-react";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { PALETTE_EVENT, SHORTCUTS_EVENT } from "@/ui/components/chat/palette-events";
import { buildAdminPaletteGroups } from "./palette-items";
import { useSettingsPaletteItems } from "./use-settings-palette-items";
import type { PaletteAction, PaletteGroup, PaletteItem } from "./palette-types";

/**
 * Global Cmd+K palette. Pass `extraGroups` for surface-specific actions
 * (e.g. recent conversations on chat). Admin routes and settings come
 * from the shared registry. The settings catalog is lazy-fetched on the
 * first open and gated on admin role so non-admin chat sessions never
 * hit `/api/v1/admin/settings`.
 */
export function GlobalCommandPalette({
  extraGroups = [],
  badges = {},
}: {
  extraGroups?: PaletteGroup[];
  badges?: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const role = useUserRole();

  // Narrow to the four roles the nav registry actually filters on. Anything
  // else (or `undefined` while session is loading) maps to `null` so the
  // sidebar's `requiredRole` check excludes platform-only groups.
  const userRole = normalizeRole(role);
  const isPlatformAdmin = userRole === "platform_admin";

  // Only resolve deploy mode for platform admins — they're the only role
  // that sees `selfHostedOnly`-filtered items (`/platform/plugins`,
  // `/platform/plugin-registry`). Without this guard the palette mounted
  // on the chat shell would fire `/api/v1/admin/settings` for every signed-
  // in member/viewer and 403 on each chat load.
  const { deployMode } = useDeployMode({ enabled: isPlatformAdmin });
  const isSaas = deployMode === "saas";

  // Cmd/Ctrl-K (and `?` outside an input) toggle the palette. Also listen
  // for the existing PALETTE_EVENT so the chat help menu's "Open command
  // palette" link still works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isShortcut =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isShortcut) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "?" && !inField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_EVENT, onOpenEvent);
    window.addEventListener(PALETTE_EVENT, onOpenEvent);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onOpenEvent);
      window.removeEventListener(PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  const adminGroups = buildAdminPaletteGroups({ userRole, isSaas, badges });
  const settingsGroups = useSettingsPaletteItems(open && userRole !== null);

  // Defer past close so a follow-on dialog/sheet (or a router push that
  // triggers Suspense) doesn't collide with Radix's body-pointer-events
  // cleanup, which leaves `pointer-events: none` on `<body>` for a frame
  // after close.
  const pendingTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = pendingTimers.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  function runAction(action: PaletteAction) {
    setOpen(false);
    const timer = setTimeout(() => {
      pendingTimers.current.delete(timer);
      Promise.resolve()
        .then(() => {
          if (action.kind === "navigate") {
            router.push(action.href);
          } else {
            return action.run();
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Silent dismissal would feel like the palette ate the click.
          // Toast keeps the user informed; the console.warn keeps Sentry's
          // breadcrumb trail accurate.
          console.warn("[palette] action failed:", msg);
          toast.error("Couldn't complete that action.", { description: msg });
        });
    }, 0);
    pendingTimers.current.add(timer);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search routes, settings, and actions"
    >
      <CommandInput placeholder="Jump to a page, find a setting, run an action…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {extraGroups.map((group, idx) => (
          <RenderGroup key={`extra-${idx}`} group={group} onSelect={runAction} />
        ))}
        {extraGroups.length > 0 && (adminGroups.length > 0 || settingsGroups.length > 0) && (
          <CommandSeparator />
        )}
        {adminGroups.map((group) => (
          <RenderGroup key={`admin-${group.heading}`} group={group} onSelect={runAction} />
        ))}
        {settingsGroups.length > 0 && <CommandSeparator />}
        {settingsGroups.map((group) => (
          <RenderGroup key={`settings-${group.heading}`} group={group} onSelect={runAction} />
        ))}
      </CommandList>
    </CommandDialog>
  );
}

function RenderGroup({
  group,
  onSelect,
}: {
  group: PaletteGroup;
  onSelect: (action: PaletteAction) => void;
}) {
  if (group.items.length === 0) return null;
  return (
    <CommandGroup heading={group.heading}>
      {group.items.map((item) => (
        <RenderItem key={item.id} item={item} onSelect={onSelect} />
      ))}
    </CommandGroup>
  );
}

/**
 * The string cmdk fuzzy-matches against. Title + hint + keywords are joined
 * so a user can type the env var (`ATLAS_ROW_LIMIT`) or the section name
 * ("Query Limits") and hit a row whose visible label is something else.
 */
export function paletteItemSearchValue(item: PaletteItem): string {
  return [item.title, item.hint, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(" ");
}

function RenderItem({
  item,
  onSelect,
}: {
  item: PaletteItem;
  onSelect: (action: PaletteAction) => void;
}) {
  const Icon = item.icon ?? ArrowRight;
  return (
    <CommandItem value={paletteItemSearchValue(item)} onSelect={() => onSelect(item.action)}>
      <Icon />
      <span className="flex-1 truncate">{item.title}</span>
      {item.badge != null && item.badge > 0 && (
        <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
      {item.hint && (
        <span className="ml-2 text-[11px] text-muted-foreground">{item.hint}</span>
      )}
    </CommandItem>
  );
}

function normalizeRole(
  role: string | undefined,
): "admin" | "member" | "platform_admin" | "viewer" | null {
  switch (role) {
    case "admin":
    case "member":
    case "platform_admin":
    case "viewer":
      return role;
    default:
      return null;
  }
}

// Re-export so callers don't need to know about the events module path.
export { PALETTE_EVENT, SHORTCUTS_EVENT } from "@/ui/components/chat/palette-events";

// Type re-exports for the chat surface that builds custom groups.
export type { PaletteAction, PaletteGroup, PaletteItem } from "./palette-types";
