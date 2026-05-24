/**
 * Group name validation for the `newGroupName` field on the admin
 * `/connections` POST + PUT routes. Post-0096 cutover (#2744 / ADR-0007)
 * the broader connection-group helper surface (CRUD, name-collision
 * checks, pg-error meta) is gone with the `connection_groups` table —
 * groups are now free-form JSONB strings in `workspace_plugins.config`,
 * with no separate lifecycle. This pattern survives because the route
 * still validates the inline `newGroupName` shape before persisting it.
 */

/**
 * Validation regex matching the existing connection-id rule. Reused so a
 * group renamed to a value that would later collide with a connection id
 * stays predictable; group rename also normalises through this so the
 * value cannot accumulate trailing whitespace that would shadow a
 * legitimate id.
 */
export const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
