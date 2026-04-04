/**
 * Base class for all EE module errors.
 * Provides typed error codes and consistent name/message/instanceof behavior.
 *
 * Usage:
 *   export type FooErrorCode = "not_found" | "conflict";
 *   export class FooError extends EEError<FooErrorCode> {
 *     readonly name = "FooError";
 *   }
 */
export class EEError<TCode extends string> extends Error {
  constructor(
    message: string,
    public readonly code: TCode,
  ) {
    super(message);
  }
}
