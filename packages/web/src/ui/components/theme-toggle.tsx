"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { setTheme, useThemeMode, type ThemeMode } from "@/ui/hooks/use-dark-mode";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const satisfies readonly { value: ThemeMode; label: string; icon: typeof Sun }[];

export interface ThemeToggleProps {
  /** Optional className passed to the trigger button. */
  className?: string;
}

/**
 * Theme picker dropdown — light / dark / system. Used in both the chat header
 * and the admin top bar so both surfaces share a single trigger and behavior.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const mode = useThemeMode();
  const CurrentIcon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8 text-muted-foreground", className)}
        >
          <CurrentIcon className="size-4" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={mode === value ? "bg-accent" : ""}
          >
            <Icon className="mr-2 size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
