// Request and response shapes of the data-safety policies (F13 on F1, F11).
// The frontend imports these as types only; the keys, defaults and reasons
// are the registry's (services/settings-registry.ts POLICIES), and
// services/settings.ts resolves them. The server decides: a control greyed
// out by a policy only shows what the API refuses anyway.

import type { AppLockArea, RelockAfter } from './devices';

/** Allowed is every key's default: nothing changes until an administrator sets a policy. */
export type Allowance = 'allowed' | 'forbidden';

/** The value of every policy key. Key names are final and stay fixed at 1.0. */
export interface PolicyValues {
  /** Creating a Download-mode mail account, or switching one to Download. Existing accounts keep working. */
  'mail.mode.download': Allowance;
  /** The same for Sync mode. */
  'mail.mode.sync': Allowance;
  /** The mode a new mail account gets; anything but user_choice is preselected and locked. */
  'mail.mode.new_accounts': 'user_choice' | 'download' | 'download_delete' | 'sync';
  /** Deleting downloaded mail at the provider; `required` applies to new accounts only. */
  'mail.provider_delete': 'user_choice' | 'forbidden' | 'required';
  /** Whether a user backup holds Download-mode mail: the person's choice, or always. */
  'backup.download_mail': 'user_choice' | 'always';
  'backup.create': Allowance;
  'backup.restore': Allowance;
  'backup.delete': Allowance;
  /**
   * The minimum age of a user backup before its owner may delete it:
   * a DELETE of a younger one is refused with POLICY_FORBIDS. Nothing is
   * ever deleted automatically; the administrator's path can delete earlier.
   * null sets no minimum.
   */
  'backup.server_retention_days': 30 | 90 | 365 | null;
  /** Adding mail and calendar accounts, and turning a mail account's linked calendar on. */
  'accounts.add': Allowance;
  /** Disconnecting or removing mail and calendar accounts, and turning a linked calendar off. */
  'accounts.remove': Allowance;
  /** Deleting UniHub's copy of an account's mail; the provider keeps it. */
  'accounts.reset': Allowance;
  /** Administrators acting on a person's accounts, backups, bin and data; always available. */
  'accounts.admin_manage': 'available';
  /** Deleting one's own UniHub account. */
  'account.delete': Allowance;
  /** Settings → Delete data, per module; also forbidden while bin.delete is. */
  'data.clear': Allowance;
  /**
   * Deleting from the bin for good and emptying it. Forbidden, it also stops
   * the automatic purge from going below the bin's minimum retention
   * (BinMinimumRetention): people may keep items longer, never shorter.
   */
  'bin.delete': Allowance;
  /**
   * The app lock every device of the person must have (0.29): [] requires
   * none, ['app'] the whole app, otherwise at least these modules. It is the
   * floor of each device's app_lock_scope; a device that does not report a
   * lock covering it is refused the locked parts (403 APP_LOCK_REQUIRED).
   * Strictest across groups: the union.
   */
  'app_lock.required': AppLockArea[];
  /** The longest time in the background before a device locks again: the floor of app_lock_relock_after; 'none' sets no limit. */
  'app_lock.max_background': 'none' | RelockAfter;
  /** Screenshots and screen recording in the Android app; browsers cannot block them. */
  'app_lock.screenshots': Allowance;
  /**
   * Two-factor authentication (0.30): `required` gives a person without it a
   * 7-day grace from when the rule first applies to them, then refuses
   * everything but setting it up (403 TWO_FACTOR_REQUIRED); turning it off
   * is refused at once.
   */
  'auth.two_factor': 'optional' | 'required';
  /** The shortest password accepted when one is set; existing passwords stay. */
  'auth.password_min_length': 12 | 14 | 16 | 20;
  /** The longest a session lives after its sign-in, in days, besides the 21-day idle rule; 'none' sets no limit. */
  'auth.session_max_days': 'none' | '30' | '14' | '7' | '1';
  /** Whether people may use the module at all; forbidden, it is off and locked for them and its data stays. */
  'modules.mail': Allowance;
  'modules.calendar': Allowance;
  'modules.contacts': Allowance;
  'modules.recordings': Allowance;
  /** The Music page alone (recordings keep working). */
  'pages.music': Allowance;
  /** The least detail notifications may show: the floor of each mail account's and the reminders' detail. */
  'notifications.detail': 'full' | 'sender' | 'none';
  /** The Android app's copy of UniHub contacts in the phone's contacts; forbidden, the phones remove it at their next sync. */
  'contacts.phone_sync': Allowance;
  /** Offline copies in browsers and the app; forbidden, new ones are refused and each device deletes its own. */
  'offline.copies': Allowance;
}

export type PolicyKey = keyof PolicyValues;

/**
 * How long the bin keeps deleted items at least while bin.delete is
 * forbidden (the bin's minimum; default 'forever': the purge then deletes nothing). It
 * becomes the floor of the person's bin_retention setting, so the settings
 * answer shows it as that setting's `floor`. Stored as policy.bin.min_retention;
 * not a PolicyKey yet, so it is its own field of the administrator's routes.
 */
export type BinMinimumRetention = '30' | '90' | 'forever';

/** Where a value comes from: an administrator's policy or the default. */
export type PolicySource = 'policy' | 'default';

/** One key as it applies to the signed-in person. */
export interface EffectivePolicy<K extends PolicyKey = PolicyKey> {
  value: PolicyValues[K];
  source: PolicySource;
  /** False when the action the key names is refused; the control is greyed out. */
  allowed: boolean;
  /** The plain sentence shown beside the control when the value is not the default; null otherwise. */
  reason: string | null;
}

/** GET /api/policies/effective */
export interface EffectivePoliciesResponse {
  policies: { [K in PolicyKey]: EffectivePolicy<K> };
  /** The installation's current rules revision. */
  revision: number;
  /** The revision this person last confirmed; below `revision`, the notice is due. */
  acknowledged_revision: number;
  /** The rules in force, in plain words, for the notice and Settings → Profile. */
  rules: string[];
  /** Whether the person must set up two-factor authentication, and until when they may wait (0.30). */
  two_factor: TwoFactorRequirement;
}

/**
 * auth.two_factor as it stands for the person: required while the rule
 * applies and they have no 2FA; grace_ends_at is the end of their 7-day
 * grace (counted from when the rule first applied to them), after which
 * everything but setting it up, signing out and the phone's background work
 * answers 403 TWO_FACTOR_REQUIRED. null when not required.
 */
export interface TwoFactorRequirement { required: boolean; grace_ends_at: string | null }

/** The details of a 403 TWO_FACTOR_REQUIRED answer. */
export interface TwoFactorRequiredDetails { grace_ended_at: string; reason: string }

/**
 * POST /api/policies/acknowledge: the revision the person saw. A revision
 * above the current one is refused (400 POLICY_REVISION_INVALID); an older
 * one records nothing new and the notice stays due.
 */
export interface AcknowledgePoliciesRequest { revision: number }
export interface AcknowledgePoliciesResponse { acknowledged_revision: number }

/** A group that sets a key, on the installation's (Everyone's) page. */
export interface AdminPolicyGroup<V = unknown> { id: string; name: string; value: V }

/**
 * One key as administrators see it. On a group's page (0.30) `value` is the
 * group's own value where it sets one (source 'policy'), else Everyone's
 * (source 'default'); `default` is Everyone's value, and a key with an order
 * lists only the values at least as strict as Everyone's: a group only makes
 * a rule stricter.
 */
export interface AdminPolicy<K extends PolicyKey = PolicyKey> {
  value: PolicyValues[K];
  source: PolicySource;
  default: PolicyValues[K];
  /** Every value the key takes, in its order of strictness where it has one. */
  values: PolicyValues[K][];
  /** What the change means for existing data, for example "Existing Sync accounts keep working". */
  effect: string | null;
  /** Everyone's page: the groups that set the key, by name; absent when none does. */
  groups?: AdminPolicyGroup<PolicyValues[K]>[];
  /**
   * Everyone's page, a key without an order (new mail accounts' mode, deleting
   * at the provider): some person's groups set different values, so Everyone's
   * value holds for them. Absent otherwise.
   */
  conflict?: true;
}

/** The bin's minimum retention as administrators see it. */
export interface AdminBinMinimumRetention {
  value: BinMinimumRetention;
  source: PolicySource;
  /** 'forever' on Everyone's page; Everyone's value on a group's. */
  default: BinMinimumRetention;
  values: BinMinimumRetention[];
  /** True while bin.delete is forbidden: only then does the minimum hold anything. */
  applies: boolean;
  effect: string;
  /** Everyone's page: the groups that set a minimum; absent when none does. */
  groups?: AdminPolicyGroup<BinMinimumRetention>[];
}

/**
 * GET /api/admin/policies (Everyone, the installation) and GET
 * /api/admin/groups/:id/policies (a group, 0.30; 404 GROUP_NOT_FOUND), both
 * with permission server.settings.
 */
export interface AdminPoliciesResponse {
  policies: { [K in PolicyKey]: AdminPolicy<K> };
  /** Always sent since 0.28 C2. */
  bin_min_retention?: AdminBinMinimumRetention;
  revision: number;
  /** A group's page (0.30): the group; absent on Everyone's page. */
  target?: { kind: 'group'; id: string; name: string };
}

/**
 * PUT /api/admin/policies: the changed values only, with the administrator's
 * password; the answer is AdminPoliciesResponse as now set. One transaction
 * with an activity-log entry per changed key (admin.policy_changed with
 * key, from, to); the revision goes up when the rules people see change.
 * Changing a policy deletes nothing. A value equal to the default removes
 * the policy. Refused with 400:
 * - POLICY_UNKNOWN: a key the server does not know
 * - POLICY_INVALID: a value the key cannot take
 * - POLICY_CONFLICT: a combination that cannot hold, for example new
 *   accounts in a mode that is not allowed, or new accounts that delete at
 *   the provider while deleting there is not allowed
 * - ADMIN_PASSWORD_REQUIRED (400) / ADMIN_PASSWORD_INCORRECT (403)
 */
export interface AdminPoliciesUpdateRequest {
  values: Partial<PolicyValues>;
  bin_min_retention?: BinMinimumRetention;
  current_password: string;
}

/**
 * PUT /api/admin/groups/:id/policies (0.30): as AdminPoliciesUpdateRequest,
 * for one group, answered with the group's AdminPoliciesResponse. A value
 * must be at least as strict as Everyone's (else 400 POLICY_INVALID); `clear`
 * removes the group's policy of each key named ('bin.min_retention' for the
 * bin's minimum), so Everyone's value holds again. Combinations are checked
 * for the group with Everyone's and for each member (400 POLICY_CONFLICT
 * naming the group or the person); 404 GROUP_NOT_FOUND.
 */
export interface AdminGroupPoliciesUpdateRequest {
  values?: Partial<PolicyValues>;
  bin_min_retention?: BinMinimumRetention;
  clear?: (PolicyKey | 'bin.min_retention')[];
  current_password: string;
}

/**
 * POST /api/admin/policies/preview (permission server.settings): before
 * saving auth.two_factor = required for Everyone (no group_id) or a group,
 * who it covers that has no 2FA, and who of them is already in a grace with
 * its end (past when it has ended). Changes nothing.
 */
export interface PolicyPreviewRequest { group_id?: string | null }
export interface PolicyPreviewPerson { id: string; email: string; full_name: string | null; grace_ends_at: string }
export interface PolicyPreviewResponse { two_factor: { without: number; in_grace: PolicyPreviewPerson[] } }

/** The details of a 403 POLICY_FORBIDS answer. */
export interface PolicyForbidsDetails {
  policy: PolicyKey;
  reason: string;
  /** POST /api/bin/empty refused between batches: what the earlier batches deleted for good. */
  deleted?: number;
}

/**
 * GET /api/auth/signup-mode gains the rules that limit a new person, in plain
 * words (the same as EffectivePoliciesResponse.rules); empty while every
 * policy is at its default. rules_revision is the revision of those rules:
 * the form sends it back as `rules_revision` with POST /api/auth/signup, and
 * the new account starts with that revision acknowledged. Without it the
 * notice shows the rules after the first sign-in.
 */
export interface SignupDataRules { data_rules: string[]; rules_revision?: number }
