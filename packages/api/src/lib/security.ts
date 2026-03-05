/**
 * Shared sensitive-pattern regex.
 *
 * Used by both the SQL tool (to scrub error messages before returning
 * them to the agent) and the audit logger (to scrub error strings before
 * persisting them). Keeping a single source of truth prevents the two
 * lists from drifting apart.
 */

export const SENSITIVE_PATTERNS =
  /password|secret|credential|connection.?string|pg_hba\.conf|SSL|certificate|Access denied for user|ER_ACCESS_DENIED_ERROR|ER_DBACCESS_DENIED_ERROR|ER_BAD_HOST_ERROR|ER_HOST_NOT_PRIVILEGED|ER_SPECIFIC_ACCESS_DENIED_ERROR|PROTOCOL_CONNECTION_LOST|Can't connect to MySQL server|Authentication failed|DB::Exception.*Authentication|UNKNOWN_USER|WRONG_PASSWORD|REQUIRED_PASSWORD|IP_ADDRESS_NOT_ALLOWED|ALL_CONNECTION_TRIES_FAILED|CLIENT_HAS_CONNECTED_TO_WRONG_PORT|AUTHENTICATION_FAILED|INVALID_SESSION_ID|LOGIN_MUST_USE_SECURITY_TOKEN|INVALID_LOGIN|INVALID_CLIENT_ID/i;
