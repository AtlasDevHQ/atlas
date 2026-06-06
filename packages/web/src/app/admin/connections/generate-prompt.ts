/**
 * Decision logic for the inline-on-add "Generate semantic layer" prompt
 * (issue #3237 door 1, docs/design/semantic-onboarding.md § E).
 *
 * Adding a SQL connection that forms a **new** Connection group offers to
 * generate a semantic layer for it. Adding a **member to an already-populated
 * group** does NOT re-prompt — that group already has its schema. The whole
 * decision is knowable from the create form's Environment selection, so it
 * lives here as pure functions rather than as another API round-trip.
 */

// Sentinel values for the Environment combobox, shared with the connection
// form (`page.tsx` imports these so there's one source of truth):
//   - `__none__`   → the connection lands ungrouped; the server mints an auto
//                    `g_<id>` singleton group (the migration-0062 invariant).
//   - `__create__` → swaps the combobox for a text input bound to a brand-new
//                    named group.
// Any other value is an existing group id the connection is joining.
export const ENV_SENTINEL_NONE = "__none__";
export const ENV_SENTINEL_CREATE = "__create__";

/**
 * Whether creating a connection with this Environment selection forms a *new*
 * Connection group. Only a new group should trigger the generate prompt:
 *
 *  - `__create__` → a brand-new named group → new.
 *  - `__none__`   → server mints an auto `g_<id>` singleton → new (this is the
 *                   common single-DB / first-DB-after-skip path).
 *  - any existing group id → joining a populated group → NOT new.
 */
export function createsNewGroup(envSelection: string): boolean {
  return envSelection === ENV_SENTINEL_NONE || envSelection === ENV_SENTINEL_CREATE;
}

/**
 * Human label for the group a newly-created connection formed, for the prompt
 * copy ("Generate semantic layer for `<label>`?"). A named group uses its
 * typed name; an auto-singleton (`__none__`) has no user-facing group name yet,
 * so we label it by the connection id — which *is* the group, of one.
 */
export function newGroupLabel(
  envSelection: string,
  newGroupName: string,
  connectionId: string,
): string {
  if (envSelection === ENV_SENTINEL_CREATE) {
    const trimmed = newGroupName.trim();
    if (trimmed) return trimmed;
  }
  return connectionId;
}
