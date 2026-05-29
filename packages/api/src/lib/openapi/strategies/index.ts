/**
 * Pagination strategy composition root.
 *
 * Assembles the {@link PaginatorRegistry} default from the built-in strategy
 * files. This is the ONLY place that knows the full set — adding a fifth
 * strategy is one new file in this directory plus one entry in
 * {@link BUILT_IN_STRATEGIES} (no edit to the paginator engine). See the
 * "Adding a fifth strategy" note in `../paginator.ts`.
 *
 * Import direction is one-way (no cycle): the engine (`../paginator`) defines
 * the SPI + helpers; each strategy file imports those; this root imports the
 * registry class and the strategy factories and wires them together.
 */
import { PaginatorRegistry, type PaginationStrategyFactory } from "../paginator";

import { cursorStrategy } from "./cursor";
import { linkHeaderStrategy } from "./link-header";
import { offsetStrategy } from "./offset";
import { pageStrategy } from "./page";

/** The four built-in strategies. Append a new file's factory here to register it. */
export const BUILT_IN_STRATEGIES: ReadonlyArray<PaginationStrategyFactory> = [
  cursorStrategy,
  offsetStrategy,
  pageStrategy,
  linkHeaderStrategy,
];

/** The process-wide registry every consumer resolves pagination config against. */
export const defaultPaginatorRegistry = new PaginatorRegistry(BUILT_IN_STRATEGIES);

export { cursorStrategy, offsetStrategy, pageStrategy, linkHeaderStrategy };
