/**
 * Shared sample data used across landing-page components.
 *
 * Hoisted here so the YAML section, the Trace component, and any future
 * surface that quotes the same NovaMart "top categories by GMV" answer all
 * read from a single source — no copy/paste drift between the result table
 * in {@link ./yaml-section.tsx} and the result strip in {@link ./trace.tsx}.
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
