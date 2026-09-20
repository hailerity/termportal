export type TerminalErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXITED'
  | 'SESSION_LIMIT_REACHED'
  | 'CLIENT_LIMIT_REACHED'
  | 'INVALID_SHELL'
  | 'INVALID_CWD'
  | 'INVALID_DIMENSIONS'
  | 'INVALID_ENV'
  | 'PTY_SPAWN_FAILED'
  | 'SESSION_TERMINATION_FAILED';

/** Domain error with a stable machine-readable code; messages are safe to show to API clients. */
export class TerminalError extends Error {
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TerminalError';
    this.code = code;
  }
}

export function isTerminalError(error: unknown): error is TerminalError {
  return error instanceof TerminalError;
}
