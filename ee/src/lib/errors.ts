/**
 * Abstract base class for all EE module errors.
 * Provides typed error codes and consistent instanceof behavior.
 * Subclasses must set `readonly name` to their class name.
 *
 * Usage:
 *   export type FooErrorCode = "not_found" | "conflict";
 *   export class FooError extends EEError<FooErrorCode> {
 *     readonly name = "FooError";
 *   }
 *   throw new FooError("item not found", "not_found");
 */
export abstract class EEError<TCode extends string> extends Error {
  abstract readonly name: string;
  constructor(
    message: string,
    public readonly code: TCode,
  ) {
    super(message);
  }
}
