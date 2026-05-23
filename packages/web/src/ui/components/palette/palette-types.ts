import type { ComponentType } from "react";

export type PaletteAction =
  | { kind: "navigate"; href: string }
  | { kind: "run"; run: () => void | Promise<void> };

export interface PaletteItem {
  /**
   * Stable id used as cmdk's `value`. Must be unique across all groups
   * — duplicate ids collide silently in cmdk's selection model.
   * Convention: prefix by source so collisions are impossible —
   * `nav:<href>`, `setting:<key>`, `convo:<id>`, `chat:<action>`.
   */
  id: string;
  /** What renders in the row. Keep short — keywords carry alt phrasing. */
  title: string;
  /** Optional second line of muted text. */
  hint?: string;
  /** Extra search tokens that match the input even when the title doesn't. */
  keywords?: string[];
  icon?: ComponentType<{ className?: string }>;
  action: PaletteAction;
  /** Positive count rendered as a chip after the title. Falsy hides the chip. */
  badge?: number;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}
