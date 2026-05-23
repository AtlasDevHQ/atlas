import type { ComponentType } from "react";

export type PaletteAction =
  | { kind: "navigate"; href: string }
  | { kind: "run"; run: () => void | Promise<void> };

export interface PaletteItem {
  /** Stable id used as cmdk's `value` — make this unique across all groups. */
  id: string;
  /** What renders in the row. Keep short — keywords carry alt phrasing. */
  title: string;
  /** Optional second line of muted text. */
  hint?: string;
  /** Extra search tokens that should match the input even when the title doesn't. */
  keywords?: string[];
  icon?: ComponentType<{ className?: string }>;
  action: PaletteAction;
  /** Badge count rendered after the title — used for the "Improve Layer" pending count. */
  badge?: number;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}
