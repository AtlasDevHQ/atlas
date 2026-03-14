/**
 * Ambient type declarations for the Atlas widget script-tag API.
 *
 * These augment `window.Atlas` and the `Atlas` global so that embedders
 * get full IDE autocomplete and type-checking.
 *
 * **Usage:** Add a triple-slash reference at the top of your script:
 *
 * ```ts
 * /// <reference types="@useatlas/react/widget" />
 *
 * window.Atlas?.open();
 * Atlas?.ask("How many users signed up today?");
 * ```
 */

import type { AtlasWidget, AtlasWidgetCommand } from "./lib/widget-types";

declare global {
  interface Window {
    /**
     * Atlas widget API — available after the widget `<script>` tag loads.
     *
     * Before the script loads, this may be an array of queued commands
     * (`AtlasWidgetCommand[]`) that are replayed once the widget initializes.
     */
    Atlas?: AtlasWidget | AtlasWidgetCommand[];
  }

  /**
   * Atlas widget API — shorthand for `window.Atlas`.
   *
   * May be `undefined` if the widget script has not loaded yet.
   */
  var Atlas: AtlasWidget | AtlasWidgetCommand[] | undefined;
}
