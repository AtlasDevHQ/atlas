"use client";

import { useState } from "react";
import { toast } from "sonner";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAtlasConfig } from "@/ui/context";
import { setTheme, useThemeMode, type ThemeMode } from "@/ui/hooks/use-dark-mode";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const satisfies readonly { value: ThemeMode; label: string; icon: typeof Sun }[];

/** Falls through name → email → "?" so the avatar always renders something. */
export function deriveInitials(name?: string | null, email?: string | null): string {
  const source = (name || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.charAt(0).toUpperCase();
}

export function UserMenu() {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const themeMode = useThemeMode();
  const [signingOut, setSigningOut] = useState(false);

  const user = session.data?.user;
  if (!user) return null;

  const name = user.name ?? null;
  const email = user.email ?? null;
  const initials = deriveInitials(name, email);

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full p-0"
          aria-label="Account menu"
        >
          <Avatar size="sm">
            <AvatarFallback className="bg-primary/10 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => { void handleSignOut(); }}
          disabled={signingOut}
        >
          <LogOut className="mr-2 size-4" />
          <span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
