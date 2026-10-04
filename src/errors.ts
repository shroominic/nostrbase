export type ErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_RECORD"
  | "INVALID_QUERY"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "RELAY_ERROR"
  | "PUBLISH_FAILED"
  | "NOT_FOUND"
  | "MULTIPLE_ROWS"
  | "ABORTED"
  | "CLIENT_CLOSED";

export class NostrbaseError extends Error {
  readonly name = "NostrbaseError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function asError(error: unknown, code: ErrorCode = "RELAY_ERROR"): NostrbaseError {
  return error instanceof NostrbaseError
    ? error
    : new NostrbaseError(code, error instanceof Error ? error.message : String(error), error);
}
