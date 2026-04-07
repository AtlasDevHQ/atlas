/**
 * EE error base — migrated to Effect Data.TaggedError.
 *
 * Each EE module now defines its own error class extending
 * `Data.TaggedError("XxxError")<{ message: string; code: XxxErrorCode }>`.
 *
 * This file is kept for backward compatibility of the test suite.
 * The abstract EEError base class has been removed — use Data.TaggedError directly.
 *
 * @see https://effect.website/docs/data-types/data/#taggerror
 */
