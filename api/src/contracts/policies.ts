// Request and response shapes of the data-safety policies (F13 on F1, F11).
// The frontend imports these as types only; the keys, defaults and reasons
// are the registry's (services/settings-registry.ts POLICIES), and
// services/settings.ts resolves them. The server decides: a control greyed
// out by a policy only shows what the API refuses anyway.

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
   * The minimum age of a user backup before its owner may delete it (D36):
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
}

export type PolicyKey = keyof PolicyValues;

/**
 * How long the bin keeps deleted items at least while bin.delete is
 * forbidden (D34; default 'forever': the purge then deletes nothing). It
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
}

/**
 * POST /api/policies/acknowledge: the revision the person saw. A revision
 * above the current one is refused (400 POLICY_REVISION_INVALID); an older
 * one records nothing new and the notice stays due.
 */
export interface AcknowledgePoliciesRequest { revision: number }
export interface AcknowledgePoliciesResponse { acknowledged_revision: number }

/** One key as administrators see it. */
export interface AdminPolicy<K extends PolicyKey = PolicyKey> {
  value: PolicyValues[K];
  source: PolicySource;
  default: PolicyValues[K];
  /** Every value the key takes, in its order of strictness where it has one. */
  values: PolicyValues[K][];
  /** What the change means for existing data, for example "Existing Sync accounts keep working". */
  effect: string | null;
}

/** The bin's minimum retention as administrators see it. */
export interface AdminBinMinimumRetention {
  value: BinMinimumRetention;
  source: PolicySource;
  default: 'forever';
  values: BinMinimumRetention[];
  /** True while bin.delete is forbidden: only then does the minimum hold anything. */
  applies: boolean;
  effect: string;
}

/** GET /api/admin/policies (permission server.settings). */
export interface AdminPoliciesResponse {
  policies: { [K in PolicyKey]: AdminPolicy<K> };
  /** Always sent since 0.28 C2. */
  bin_min_retention?: AdminBinMinimumRetention;
  revision: number;
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
