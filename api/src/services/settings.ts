import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { db } from '../state';

// The settings UniHub stores, by scope. A user's preferences live in
// user_settings (archived with the Settings backup section; restore remaps
// default_mail_account_id, which names a mail account). Module and page
// choices share that table but belong to module-settings.ts. Server settings
// live in system_settings, outside user recovery.
interface Preference { default: string; values?: readonly string[]; maxLength?: number }

const USER_PREFERENCES = {
  email_link_behavior: { default: 'mailto', values: ['mailto', 'internal'] },
  default_start_page: { default: 'mail', values: ['mail', 'calendar', 'todo', 'contacts', 'recordings', 'music', 'dashboard'] },
  /** The account new messages are sent from; empty means the first account. */
  default_mail_account_id: { default: '', maxLength: 36 },
  /** The accent colour of the app; the choices live in the frontend (src/lib/accent.ts). */
  accent_color: { default: 'blue', values: ['blue', 'indigo', 'violet', 'pink', 'teal', 'green'] },
} satisfies Record<string, Preference>;

type PreferenceKey = keyof typeof USER_PREFERENCES;
type Preferences = Record<PreferenceKey, string>;

const isPreference = (key: string): key is PreferenceKey => Object.prototype.hasOwnProperty.call(USER_PREFERENCES, key);
const allowed = (key: PreferenceKey, value: string) => {
  const preference: Preference = USER_PREFERENCES[key];
  return preference.values ? preference.values.includes(value) : value.length <= (preference.maxLength ?? 255);
};

async function getUserPreferences(userId: string, executor: SqlExecutor = db): Promise<Preferences> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?', [userId]);
  const preferences = Object.fromEntries(Object.entries(USER_PREFERENCES).map(([key, preference]) => [key, preference.default])) as Preferences;
  for (const row of rows) {
    // A value no longer offered (for example the removed Notes start page) falls back to the default.
    if (isPreference(row.setting_key) && allowed(row.setting_key, String(row.setting_value))) preferences[row.setting_key] = String(row.setting_value);
  }
  return preferences;
}

/** Saves the known preferences in `input` (others are ignored); every value is checked before any is written. */
async function setUserPreferences(userId: string, input: Record<string, unknown> = {}) {
  const updates: [PreferenceKey, string][] = [];
  for (const [key, value] of Object.entries(input || {})) {
    if (!isPreference(key)) continue;
    const normalized = String(value || '').trim();
    if (!allowed(key, normalized)) return { error: `Invalid value for ${key}`, status: 400 };
    if (key === 'default_mail_account_id' && normalized) {
      const [owned] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL', [normalized, userId]);
      if (!owned.length) return { error: 'Choose one of your connected mail accounts', status: 400 };
    }
    updates.push([key, normalized]);
  }
  for (const [key, value] of updates) {
    await db.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [userId, key, value]);
  }
  return { preferences: await getUserPreferences(userId) };
}

const SIGNUP_MODES = ['open', 'approval', 'disabled'] as const;
type SignupMode = typeof SIGNUP_MODES[number];
const isSignupMode = (value: unknown): value is SignupMode => SIGNUP_MODES.includes(value as SignupMode);

/** Who may create an account; anything unreadable counts as closed. */
async function getSignupMode(executor: SqlExecutor = db): Promise<SignupMode> {
  try {
    const [rows] = await executor.execute<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'signup_mode'");
    return isSignupMode(rows[0]?.setting_value) ? rows[0].setting_value : 'disabled';
  } catch {
    return 'disabled';
  }
}

async function setSignupMode(mode: SignupMode, executor: SqlExecutor = db) {
  await executor.execute(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('signup_mode', ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [mode]);
}

export {
  USER_PREFERENCES,
  getUserPreferences,
  setUserPreferences,
  SIGNUP_MODES,
  isSignupMode,
  getSignupMode,
  setSignupMode,
};
export type { SignupMode };
