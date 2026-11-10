// Kept apart from the API client: views recognise the error, and modules unwrap
// responses, without importing the client (which tests replace).
/**
 * A failed API request as an Error, for feature modules to throw: callers can
 * branch on the server's `code`, and a server failure carries the request id
 * the server logged it under.
 */
import type { AppLockArea, AppLockRequiredDetails, RelockAfter } from '../../api/src/contracts/devices';

type FailedResponse = { error?: string; status?: number; [key: string]: unknown };

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  /** What the server adds to a refusal, for example how far a stopped operation got (`{ deleted }`). */
  readonly details?: unknown;
  constructor(response: FailedResponse) {
    super(response.error || 'The request failed.');
    this.name = 'ApiError';
    this.status = response.status;
    if (typeof response.code === 'string') this.code = response.code;
    if (response.details !== undefined) this.details = response.details;
    if (typeof response.requestId === 'string') this.requestId = response.requestId;
  }
}

/**
 * 403 APP_LOCK_REQUIRED: the administrator requires an app lock this device
 * does not report, and the request was refused before it did anything. The
 * API client also tells the app lock provider, which shows the set-up prompt;
 * a view shows no error of its own for it.
 */
export const APP_LOCK_REQUIRED = 'APP_LOCK_REQUIRED';

export class AppLockRequired extends ApiError {
  readonly requirement: AppLockRequiredDetails;
  constructor(response: FailedResponse) {
    super(response);
    this.name = 'AppLockRequired';
    this.requirement = appLockRequiredDetails(response.details);
  }
}

const AREAS: readonly AppLockArea[] = ['app', 'mail', 'contacts', 'calendar', 'recordings'];
const RELOCK: readonly RelockAfter[] = ['0', '60', '300', '900'];

/** The refusal's details, keeping only known values (an unknown area is left out, a missing reason is null). */
export function appLockRequiredDetails(details: unknown): AppLockRequiredDetails {
  const value = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const required = Array.isArray(value.required) ? AREAS.filter(area => (value.required as unknown[]).includes(area)) : [];
  return {
    required: required.includes('app') ? ['app'] : required,
    max_background: RELOCK.includes(value.max_background as RelockAfter) ? value.max_background as RelockAfter : null,
    reason: typeof value.reason === 'string' && value.reason ? value.reason : null,
  };
}

/** The data of a successful response; a failed one throws ApiError (AppLockRequired for 403 APP_LOCK_REQUIRED). */
export function unwrap<T>(response: FailedResponse & { data?: T }): T | undefined {
  if (response.error) throw response.status === 403 && response.code === APP_LOCK_REQUIRED ? new AppLockRequired(response) : new ApiError(response);
  return response.data;
}

/** Whether `error` is the server's refusal with this code (an ApiError). */
export const hasCode = (error: unknown, code: string): error is ApiError => error instanceof ApiError && error.code === code;

/**
 * 409 ACCOUNT_CHANGED: the account a change chose was changed by another
 * request meanwhile, and nothing was written. The caller shows the server's
 * sentence, reads the account (or its list) again and keeps what the person
 * typed, so they can try again.
 */
export const ACCOUNT_CHANGED = 'ACCOUNT_CHANGED';
