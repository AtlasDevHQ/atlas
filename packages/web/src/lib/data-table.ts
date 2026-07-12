import type { Column } from "@tanstack/react-table";
import { dataTableConfig } from "@/config/data-table";
import type {
  FilterOperator,
  FilterVariant,
} from "@/types/data-table";

export function getColumnPinningStyle<TData>({
  column,
  withBorder = false,
}: {
  column: Column<TData>;
  withBorder?: boolean;
}): React.CSSProperties {
  const isPinned = column.getIsPinned();
  const isLastLeftPinnedColumn =
    isPinned === "left" && column.getIsLastColumn("left");
  const isFirstRightPinnedColumn =
    isPinned === "right" && column.getIsFirstColumn("right");

  return {
    boxShadow: withBorder
      ? isLastLeftPinnedColumn
        ? "-4px 0 4px -4px var(--border) inset"
        : isFirstRightPinnedColumn
          ? "4px 0 4px -4px var(--border) inset"
          : undefined
      : undefined,
    left: isPinned === "left" ? `${column.getStart("left")}px` : undefined,
    right: isPinned === "right" ? `${column.getAfter("right")}px` : undefined,
    opacity: isPinned ? 0.97 : 1,
    position: isPinned ? "sticky" : "relative",
    background: isPinned ? "var(--background)" : "var(--background)",
    width: column.getSize(),
    zIndex: isPinned ? 1 : undefined,
  };
}

/**
 * Props that turn a table `<tr>` into a keyboard-operable button. A clickable
 * row is otherwise pointer-only — no focus, no Enter/Space — so keyboard and
 * screen-reader users can't reach a row-opened detail view at all. Spreading
 * these onto the row gives it `role="button"`, tab focus, a focus-visible ring,
 * and Enter/Space activation, all wired to the same `onActivate` the click uses.
 *
 * The keydown only fires `onActivate` when the row is itself the event target,
 * so Enter/Space on a nested control (a selection checkbox, a row action menu)
 * keeps its own default instead of being hijacked (and swallowed by the row's
 * `preventDefault`) into opening the row.
 *
 * `role="button"` on the row mirrors the clickable-row contract established for
 * the chat data table (#3212). It overrides the `<tr>`'s implicit `role="row"`,
 * a deliberate trade for these row-opens-a-detail-sheet admin tables; the target
 * guard above is what keeps the row's own nested controls operable despite it.
 *
 * Shared by the plain and expandable data tables so both keep one identical
 * keyboard contract: each calls this with its row's activation callback (the
 * plain table forwards the event, the expandable one omits it), so the helper —
 * not the caller — owns the `onClick`/`onKeyDown` wiring. A non-interactive row
 * spreads `{}` instead and is left untouched.
 */
export function interactiveRowProps(
  onActivate: (event: React.MouseEvent | React.KeyboardEvent) => void,
): {
  role: "button";
  tabIndex: 0;
  className: string;
  onClick: React.MouseEventHandler;
  onKeyDown: React.KeyboardEventHandler;
} {
  return {
    role: "button",
    tabIndex: 0,
    className:
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    onClick: onActivate,
    onKeyDown: (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target === event.currentTarget
      ) {
        event.preventDefault();
        onActivate(event);
      }
    },
  };
}

export function getFilterOperators(filterVariant: FilterVariant) {
  const operatorMap: Record<
    FilterVariant,
    { label: string; value: FilterOperator }[]
  > = {
    text: dataTableConfig.textOperators,
    number: dataTableConfig.numericOperators,
    range: dataTableConfig.numericOperators,
    date: dataTableConfig.dateOperators,
    dateRange: dataTableConfig.dateOperators,
    boolean: dataTableConfig.booleanOperators,
    select: dataTableConfig.selectOperators,
    multiSelect: dataTableConfig.multiSelectOperators,
  };

  return operatorMap[filterVariant] ?? dataTableConfig.textOperators;
}

export function getDefaultFilterOperator(filterVariant: FilterVariant) {
  const operators = getFilterOperators(filterVariant);

  return operators[0]?.value ?? (filterVariant === "text" ? "iLike" : "eq");
}
