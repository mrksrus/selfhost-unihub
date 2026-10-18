import type { ApiError as ThrownError } from '../types';

// The one rule for what a client sees when a route or service throws. An error
// carrying a 4xx status describes the request and reaches the client with its
// status, code and message; anything else is a server failure whose text (a
// database driver's, a file system's) stays in the log.
class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status >= 400 && status < 500;
  }
}

const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
const unauthorized = (code: string, message: string, details?: unknown) => new ApiError(401, code, message, details);
const forbidden = (code: string, message: string, details?: unknown) => new ApiError(403, code, message, details);
const notFound = (code: string, message: string, details?: unknown) => new ApiError(404, code, message, details);
const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

interface ClientErrorResponse { error: string; status: number; code?: string; details?: unknown }

// Route catch blocks and the request boundary answer a caught error through
// this: a 4xx with a message meant for the client keeps it, everything else
// becomes the route's fallback text with status 500.
function clientError(error: unknown, fallback: string): ClientErrorResponse {
  const thrown = error as (ThrownError & { expose?: boolean; details?: unknown }) | null | undefined;
  const status = thrown?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 && thrown!.expose !== false) {
    return {
      error: thrown!.message || fallback,
      status,
      ...(thrown!.code ? { code: thrown!.code } : {}),
      ...(thrown!.details !== undefined ? { details: thrown!.details } : {}),
    };
  }
  return { error: fallback, status: 500 };
}

export { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, clientError };
export type { ClientErrorResponse };
