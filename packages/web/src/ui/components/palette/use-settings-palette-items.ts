"use client";

import { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import type { PaletteGroup, PaletteItem } from "./palette-types";

const SettingSchema = z.object({
  key: z.string(),
  section: z.string(),
  label: z.string(),
  description: z.string(),
  envVar: z.string(),
  scope: z.enum(["platform", "workspace"]),
});

const SettingsResponseSchema = z.object({
  settings: z.array(SettingSchema),
  manageable: z.boolean(),
});

/**
 * Lazy-load the settings catalog only when the palette is opened. The
 * catalog is small (~30 keys) and admin-only — non-admins won't have access
 * anyway, so we gate the request on `enabled` to keep the chat surface from
 * hitting an admin endpoint on every page load.
 *
 * Returns one palette group per settings section. Each item deep-links to
 * `/admin/settings#setting-<key>`; the settings page reads the hash on mount
 * and scrolls/highlights the matching row.
 */
export function useSettingsPaletteItems(enabled: boolean): PaletteGroup[] {
  const { data } = useAdminFetch("/api/v1/admin/settings", {
    schema: SettingsResponseSchema,
    enabled,
  });

  // Zod parses the body in production, but test mocks may return arbitrary
  // shapes — guard explicitly so the palette never hard-crashes its host tree.
  const settings = data?.settings;
  if (!settings || !Array.isArray(settings)) return [];

  // Workspace-scoped settings only — platform settings live at /platform/settings.
  const bySection = new Map<string, PaletteItem[]>();
  for (const s of settings) {
    if (s.scope !== "workspace") continue;
    const items = bySection.get(s.section) ?? [];
    items.push({
      id: `setting:${s.key}`,
      title: s.label,
      hint: `Settings → ${s.section}`,
      // Searching the env var or the raw key is the muscle memory most
      // operators have. `description` carries the human phrasing.
      keywords: [s.key, s.envVar, s.description, s.section],
      action: { kind: "navigate", href: `/admin/settings#setting-${s.key}` },
    });
    bySection.set(s.section, items);
  }

  return [...bySection.entries()].map(([section, items]) => ({
    heading: `Setting: ${section}`,
    items,
  }));
}
