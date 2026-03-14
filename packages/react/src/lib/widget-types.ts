/**
 * TypeScript type definitions for the Atlas widget script-tag API.
 *
 * When embedded via `<script src="https://api.example.com/widget.js">`,
 * the loader exposes `window.Atlas` with a programmatic API for controlling
 * the chat widget.
 *
 * **Usage for embedders:**
 *
 * Add a triple-slash reference at the top of your script to get full
 * autocomplete and type-checking:
 *
 * ```ts
 * /// <reference types="@useatlas/react/widget" />
 *
 * Atlas.open();
 * Atlas.ask("How many users signed up today?");
 * Atlas.on("queryComplete", (detail) => {
 *   console.log("Query returned", detail.rowCount, "rows");
 * });
 * ```
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/**
 * Map of event names to their detail payloads.
 *
 * Used by {@link AtlasWidget.on} to provide type-safe event handling.
 */
export interface AtlasWidgetEventMap {
  /** Fired when the widget panel opens. */
  open: Record<string, never>;
  /** Fired when the widget panel closes. */
  close: Record<string, never>;
  /** Fired when a SQL query completes inside the widget. */
  queryComplete: { sql?: string; rowCount?: number };
  /** Fired when the widget encounters an error. */
  error: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Script-tag configuration (data-* attributes)
// ---------------------------------------------------------------------------

/**
 * Configuration options read from `data-*` attributes on the `<script>` tag.
 *
 * @example
 * ```html
 * <script src="https://api.example.com/widget.js"
 *   data-api-url="https://api.example.com"
 *   data-api-key="sk-..."
 *   data-theme="dark"
 *   data-position="bottom-left"
 *   data-on-open="onAtlasOpen"
 *   data-on-error="onAtlasError">
 * </script>
 * ```
 */
export interface AtlasWidgetConfig {
  /**
   * Base URL of the Atlas API (required).
   *
   * Must use `http:` or `https:` protocol.
   */
  apiUrl: string;
  /**
   * API key for authentication (optional).
   *
   * Passed to the widget iframe as an auth token.
   */
  apiKey?: string;
  /**
   * Widget color theme (optional, default `"light"`).
   */
  theme?: "light" | "dark";
  /**
   * Position of the floating chat bubble (optional, default `"bottom-right"`).
   */
  position?: "bottom-right" | "bottom-left";
  /**
   * Name of a global function called when the widget opens (optional).
   *
   * The function must exist on `window` at the time the event fires.
   */
  onOpen?: string;
  /**
   * Name of a global function called when the widget closes (optional).
   */
  onClose?: string;
  /**
   * Name of a global function called when a query completes (optional).
   */
  onQueryComplete?: string;
  /**
   * Name of a global function called when the widget encounters an error (optional).
   */
  onError?: string;
}

// ---------------------------------------------------------------------------
// Programmatic API
// ---------------------------------------------------------------------------

/**
 * Programmatic API exposed on `window.Atlas` after the widget script loads.
 *
 * @example
 * ```ts
 * /// <reference types="@useatlas/react/widget" />
 *
 * // Open the widget
 * Atlas.open();
 *
 * // Send a question programmatically
 * Atlas.ask("What are the top 10 customers by revenue?");
 *
 * // Listen for events
 * Atlas.on("queryComplete", (detail) => {
 *   console.log(`Query returned ${detail.rowCount} rows`);
 * });
 *
 * // Change theme at runtime
 * Atlas.setTheme("dark");
 *
 * // Clean up when done
 * Atlas.destroy();
 * ```
 */
export interface AtlasWidget {
  /**
   * Opens the widget panel.
   *
   * No-op if the widget has been destroyed.
   */
  open(): void;

  /**
   * Closes the widget panel.
   *
   * No-op if the widget has been destroyed.
   */
  close(): void;

  /**
   * Toggles the widget panel open or closed.
   *
   * No-op if the widget has been destroyed.
   */
  toggle(): void;

  /**
   * Opens the widget and sends a question to the Atlas agent.
   *
   * @param question - The natural-language question to ask.
   *
   * @example
   * ```ts
   * Atlas.ask("How many users signed up this week?");
   * ```
   */
  ask(question: string): void;

  /**
   * Removes the widget from the DOM, cleans up all event listeners,
   * and deletes `window.Atlas`.
   *
   * After calling `destroy()`, all other methods become no-ops.
   */
  destroy(): void;

  /**
   * Binds a type-safe event listener.
   *
   * Supported events: `"open"`, `"close"`, `"queryComplete"`, `"error"`.
   *
   * @param event   - The event name.
   * @param handler - Callback receiving the event detail payload.
   *
   * @example
   * ```ts
   * Atlas.on("error", (detail) => {
   *   console.error(`Atlas error [${detail.code}]: ${detail.message}`);
   * });
   * ```
   */
  on<K extends keyof AtlasWidgetEventMap>(
    event: K,
    handler: (detail: AtlasWidgetEventMap[K]) => void,
  ): void;

  /**
   * Sends an authentication token to the widget iframe.
   *
   * Use this when the auth token is obtained after the script tag loads
   * (e.g., after a user logs in).
   *
   * @param token - The authentication token string.
   */
  setAuthToken(token: string): void;

  /**
   * Sets the widget color theme at runtime.
   *
   * @param theme - `"light"` or `"dark"`.
   */
  setTheme(theme: "light" | "dark"): void;
}

/**
 * Pre-load command queue entry.
 *
 * Before the widget script loads, `window.Atlas` can be set to an array
 * of queued commands that are replayed once the widget initializes:
 *
 * ```ts
 * window.Atlas = window.Atlas || [];
 * Atlas.push(["open"]);
 * Atlas.push(["ask", "How many users signed up today?"]);
 * ```
 *
 * Each entry is a tuple of `[methodName, ...args]`.
 */
export type AtlasWidgetCommand = [
  keyof AtlasWidget,
  ...unknown[],
];
