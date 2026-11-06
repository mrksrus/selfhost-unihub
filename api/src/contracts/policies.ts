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
  /** Days the server keeps each user backup before removing it; null keeps it until deleted. */
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
  /** Deleting from the bin for good and emptying it. */
  'bin.delete': Allowance;
}

export type PolicyKey = keyof PolicyValues;

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

/** POST /api/policies/acknowledge: the revision the person saw. */
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

/** GET /api/admin/policies (permission server.settings). */
export interface AdminPoliciesResponse {
  policies: { [K in PolicyKey]: AdminPolicy<K> };
  revision: number;
}

/**
 * PUT /api/admin/policies: the changed values only, with the administrator's
 * password. One transaction with the activity-log entry; changing a policy
 * deletes nothing.
 */
export interface AdminPoliciesUpdateRequest {
  values: Partial<PolicyValues>;
  current_password: string;
}

/** The details of a 403 POLICY_FORBIDS answer. */
export interface PolicyForbidsDetails {
  policy: PolicyKey;
  reason: string;
}

/** GET /api/auth/signup-mode gains the rules that limit a new person, in plain words. */
export interface SignupDataRules { data_rules: string[] }
