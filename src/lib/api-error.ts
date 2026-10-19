// Kept apart from the API client: views recognise the error, and modules unwrap
// responses, without importing the client (which tests replace).
/**
 * A failed API request as an Error, for feature modules to throw: callers can
 * branch on the server's `code`, and a server failure carries the request id
 * the server logged it under.
 */
type FailedResponse = { error?: string; status?: number; [key: string]: unknown };

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(response: FailedResponse) {
    super(response.error || 'The request failed.');
    this.name = 'ApiError';
    this.status = response.status;
    if (typeof response.code === 'string') this.code = response.code;
    if (typeof response.requestId === 'string') this.requestId = response.requestId;
  }
}

/** The data of a successful response; a failed one throws ApiError. */
export function unwrap<T>(response: FailedResponse & { data?: T }): T | undefined {
  if (response.error) throw new ApiError(response);
  return response.data;
}
