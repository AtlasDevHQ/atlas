/**
 * Shared sample data used across landing-page components.
 *
 * Hoisted here so the hero answer card and the how-it-works reply pane, plus
 * any future surface that quotes the same NovaMart "top categories by GMV"
 * answer, read from a single source. No copy/paste drift between them.
 */
export type CategoryRow = {
  readonly category: string;
  readonly gmv: string;
  readonly orders: string;
};

export const CATEGORY_ROWS: ReadonlyArray<CategoryRow> = [
  { category: "Bedding",     gmv: "$184,219", orders: "2,041" },
  { category: "Kitchen",     gmv: "$142,718", orders: "1,587" },
  { category: "Bath",        gmv: "$98,402",  orders: "1,103" },
  { category: "Outdoor",     gmv: "$71,288",  orders: "812"   },
  { category: "Accessories", gmv: "$54,011",  orders: "693"   },
];

/**
 * The canonical demo question. Shared by the hero answer card and the
 * how-it-works reply pane so the prompt text never drifts between surfaces.
 */
export const TOP_CATEGORY_QUESTION =
  "What's our top-performing category by GMV this month?";
