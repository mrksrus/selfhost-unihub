// Kept apart from the API client: views recognise the error, and modules unwrap
// responses, without importing the client (which tests replace).
/**
 * A failed API request as an Error, for feature modules to throw: callers can
 * branch on the server's `code`, and a server failure carries the request id
 * the server logged it under.
 */
import type { AppLockArea, AppLockRequiredDetails, RelockAfter } from '../../api/src/contracts/devices';
import type { PolicyKey } from '../../api/src/contracts/policies';

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

/**
 * 403 TWO_FACTOR_REQUIRED (0.30): two-factor authentication is required and
 * the person's 7-day grace has ended, so only setting it up, signing out and
 * the phone's background work still answer. Like APP_LOCK_REQUIRED, the API
 * client announces it (app event 'unihub:two-factor-required') and the app
 * shows the set-up prompt; a view shows no error of its own for it.
 */
export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

export interface TwoFactorRequiredDetails {
  /** When the grace ended (UTC ISO); null when the server did not say. */
  grace_ended_at: string | null;
  reason: string | null;
}

export function twoFactorRequiredDetails(details: unknown): TwoFactorRequiredDetails {
  const value = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const ended = typeof value.grace_ended_at === 'string' && !Number.isNaN(Date.parse(value.grace_ended_at)) ? value.grace_ended_at : null;
  return { grace_ended_at: ended, reason: typeof value.reason === 'string' && value.reason ? value.reason : null };
}

export const MODULE_DISABLED = 'MODULE_DISABLED';
export const POLICY_FORBIDS = 'POLICY_FORBIDS';

/**
 * The administrator's rule behind a refusal: 403 POLICY_FORBIDS, or (0.30)
 * 403 MODULE_DISABLED with `details { policy, reason }` for a module, page or
 * phone-contacts policy. Null for anything else, including a module the
 * person switched off themselves (MODULE_DISABLED without details), so the
 * page can say who to ask.
 */
export function policyRefusal(error: unknown): { policy: PolicyKey | null; reason: string } | null {
  if (!(error instanceof ApiError) || error.status !== 403 || (error.code !== POLICY_FORBIDS && error.code !== MODULE_DISABLED)) return null;
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const policy = typeof details.policy === 'string' && details.policy ? details.policy as PolicyKey : null;
  if (error.code === MODULE_DISABLED && !policy) return null;
  return { policy, reason: typeof details.reason === 'string' && details.reason ? details.reason : error.message };
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
