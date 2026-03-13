/**
 * Client-side error parsing for Atlas chat errors.
 *
 * The server returns JSON error bodies with { error, message, retryAfterSeconds? }.
 * This module parses those into user-friendly `ChatErrorInfo` objects.
 */

export * from "@useatlas/types/errors";
