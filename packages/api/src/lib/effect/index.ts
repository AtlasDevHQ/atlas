/**
 * Effect.ts foundation for Atlas.
 *
 * Re-exports tagged error types and the Hono bridge so consumers can
 * import from a single entry point:
 *
 * ```ts
 * import { runEffect, EmptyQueryError, ParseError } from "@atlas/api/lib/effect";
 * ```
 */

export {
  // SQL validation
  EmptyQueryError,
  ForbiddenPatternError,
  ParseError,
  WhitelistError,
  // Connection
  ConnectionNotFoundError,
  PoolExhaustedError,
  NoDatasourceError,
  // Query execution
  QueryTimeoutError,
  QueryExecutionError,
  // Rate limiting
  RateLimitExceededError,
  ConcurrencyLimitError,
  // RLS
  RLSError,
  // Enterprise
  EnterpriseGateError,
  ApprovalRequiredError,
  // Plugin
  PluginRejectedError,
  CustomValidatorError,
  // Action
  ActionTimeoutError,
  // Scheduler
  SchedulerTaskTimeoutError,
  SchedulerExecutionError,
  DeliveryError,
  // Union type
  type AtlasError,
  type AtlasErrorTag,
} from "./errors";

export { runEffect, mapTaggedError } from "./hono";
