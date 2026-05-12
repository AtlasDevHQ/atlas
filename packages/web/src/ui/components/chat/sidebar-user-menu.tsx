"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Sun,
  User,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth/client";
import { deriveInitials } from "@/ui/components/user-menu";
import { setTheme, useThemeMode, type ThemeMode } from "@/ui/hooks/use-dark-mode";

interface OrgOption {
  id: string;
  name: string;
  slug: string;
}

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const satisfies readonly { value: ThemeMode; label: string; icon: typeof Sun }[];

// Claude-style combined identity row: avatar + name + active-org subtitle in
// one SidebarMenuButton, with org switching + user actions inside a single
// dropdown. Replaces the split OrgSwitcher (header) + UserMenu (footer)
// in the chat-surface sidebar only — the standalone components are still
// used by /settings, /admin top bar, and the embeddable <AtlasChat>.
export function SidebarUserMenu() {
  const session = authClient.useSession();
  const themeMode = useThemeMode();
  const { isMobile } = useSidebar();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  const user = session.data?.user;
  const sessionExtra = session.data?.session as
    | { activeOrganizationId?: string; activeOrganizationName?: string }
    | undefined;
  const activeOrgId = sessionExtra?.activeOrganizationId;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    authClient.organization
      .list()
      .then((res) => {
        if (!cancelled && res.data) setOrgs(res.data as OrgOption[]);
      })
      .catch((err) => {
        console.error("Failed to load organizations:", err);
      })
      .finally(() => {
        if (!cancelled) setOrgsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  const name = user.name ?? null;
  const email = user.email ?? null;
  const initials = deriveInitials(name, email);
  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const orgName = activeOrg?.name ?? sessionExtra?.activeOrganizationName ?? null;
  const canSwitch = orgs.length > 1;
  const subtitle = orgName ?? email ?? null;

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
      window.location.assign("/login");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Sign out failed:", message);
      toast.error("Sign out failed. Try again.");
      setSigningOut(false);
    }
  }

  async function switchOrg(orgId: string) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      window.location.reload();
    } catch (err) {
      console.error("Failed to switch organization:", err);
      toast.error("Failed to switch organization. Try again.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          tooltip={name ?? email ?? "Account"}
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <Avatar className="size-8 shrink-0 rounded-lg">
            <AvatarFallback className="rounded-lg bg-primary/10 text-[11px] font-semibold text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">{name ?? "Signed in"}</span>
            {subtitle && (
              <span className="truncate text-xs text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
          <ChevronsUpDown className="ml-auto size-4 opacity-50 group-data-[collapsible=icon]:hidden" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isMobile ? "bottom" : "right"}
        align="end"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          {name && <span className="truncate text-sm font-medium">{name}</span>}
          {email && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {email}
            </span>
          )}
          {!name && !email && <span className="text-sm">Signed in</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/settings/profile">
              <User className="mr-2 size-4" />
              <span>Profile</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {themeMode === "dark" ? (
                <Moon className="mr-2 size-4" />
              ) : themeMode === "light" ? (
                <Sun className="mr-2 size-4" />
              ) : (
                <Monitor className="mr-2 size-4" />
              )}
              <span>Theme</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => setTheme(value)}
                  className={themeMode === value ? "bg-accent" : ""}
                >
                  <Icon className="mr-2 size-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        {!orgsLoading && canSwitch && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
              Switch organization
            </DropdownMenuLabel>
            {orgs.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onClick={() => switchOrg(org.id)}
                className="gap-2"
              >
                <div className="flex size-6 items-center justify-center rounded bg-primary/10 text-xs font-semibold">
                  {org.name.charAt(0).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{org.name}</span>
                {org.id === activeOrgId && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void handleSignOut();
          }}
          disabled={signingOut}
        >
          <LogOut className="mr-2 size-4" />
          <span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
