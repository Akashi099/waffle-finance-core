/**
 * Typed error hierarchy for coordinator client failures.
 *
 * Separating error classes lets callers use `instanceof` guards instead of
 * inspecting raw `error` strings, which is more refactor-safe.
 */

/** Base class for all coordinator client errors. */
export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

/**
 * The coordinator returned a 4xx or 5xx response.
 *
 * `code` is the stable machine-readable `error` field from the response body.
 * `retryable` mirrors the coordinator's hint when present.
 */
export class CoordinatorApiError extends CoordinatorError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "CoordinatorApiError";
  }
}

/** The coordinator returned a response that could not be parsed as JSON. */
export class CoordinatorParseError extends CoordinatorError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CoordinatorParseError";
  }
}

/** A network-level failure (no response received). */
export class CoordinatorNetworkError extends CoordinatorError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CoordinatorNetworkError";
  }
}

/** The request was locally invalid and was never sent to the coordinator. */
export class CoordinatorValidationError extends CoordinatorError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "CoordinatorValidationError";
  }
}
