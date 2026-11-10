import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import { db } from '../state';
import { clearAuthCookie, clearCsrfCookie, getAuthTokenFromRequest } from '../auth';
import { clientError } from '../http/errors';
import { clearModuleData, CLEAR_MODULES } from '../services/data-clear';
import type { ClearTarget } from '../services/data-clear';
import type { PolicyKey } from '../contracts/policies';
import { confirmPasswordHash, OWN_CODES } from '../security/reauthentication';
import { asCaller } from '../services/caller-proof';
import {
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  normalizeSenderDomain,
} from '../services/mail';
import { deleteUser } from '../services/user-lifecycle';
import { getScopedSettings, getSettings, getUserPreferences, setUserPreferences, updateSettings } from '../services/settings';
import { changeUserSettings } from '../services/bin';
import { currentDevice } from '../services/devices';
import type {
  CalendarSettingsResponse,
  CalendarSettingValues,
  DeviceSettingsResponse,
  MailAccountSettingsResponse,
  MailAccountSettingValues,
  ScopedSettingsResponse,
  UserSettingsResponse,
} from '../contracts/settings';
import { defineRoutes } from '../http/route';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = Record<string, unknown>;

function clearRoute(target: ClearTarget, destructive: readonly PolicyKey[]) {
  return {
    auth: 'user' as const, module: CLEAR_MODULES[target], restoreSection: CLEAR_MODULES[target], destructive,
    handler: async (_req: Request, userId: string) => {
      try {
        return await clearModuleData(userId, target);
      } catch (error) {
        if (!(error as ApiError).status) console.error(`Clear ${target} error:`, error);
        return clientError(error, 'Failed to delete the data');
      }
    },
  };
}

export = defineRoutes({
  // The settings registry (F1). Mail-account and calendar settings follow
  // their module's switch and restore lock.
  'GET /api/settings/values': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    try {
      return { settings: await getSettings('user', userId) } satisfies UserSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Get settings error:', error);
      return clientError(error, 'Failed to load settings');
    }
  } },
  'PUT /api/settings/values': { auth: 'user', module: null, restoreSection: 'settings', handler: async (req: Request, userId: string, body: Input) => {
    try {
      // A new bin retention applies to what is in the bin already (services/bin.ts).
      return { settings: await changeUserSettings(userId, body) } satisfies UserSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update settings error:', error);
      return clientError(error, 'Failed to save settings');
    }
  } },
  'GET /api/settings/values/mail-accounts': { auth: 'user', module: 'mail', handler: async (req: Request, userId: string) => {
    try {
      return { accounts: await getScopedSettings('mail_account', userId) } satisfies MailAccountSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Get mail account settings error:', error);
      return clientError(error, 'Failed to load mail account settings');
    }
  } },
  'PUT /api/settings/values/mail-accounts/:id': { auth: 'user', module: 'mail', restoreSection: 'mail', handler: async (req: Request, userId: string, body: Input) => {
    try {
      return { id: req.params.id, settings: await updateSettings('mail_account', userId, req.params.id, body) } satisfies ScopedSettingsResponse<MailAccountSettingValues>;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update mail account settings error:', error);
      return clientError(error, 'Failed to save mail account settings');
    }
  } },
  'GET /api/settings/values/calendars': { auth: 'user', module: 'calendar', handler: async (req: Request, userId: string) => {
    try {
      return { calendars: await getScopedSettings('calendar', userId) } satisfies CalendarSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Get calendar settings error:', error);
      return clientError(error, 'Failed to load calendar settings');
    }
  } },
  'PUT /api/settings/values/calendars/:id': { auth: 'user', module: 'calendar', restoreSection: 'calendar', handler: async (req: Request, userId: string, body: Input) => {
    try {
      return { id: req.params.id, settings: await updateSettings('calendar', userId, req.params.id, body) } satisfies ScopedSettingsResponse<CalendarSettingValues>;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update calendar settings error:', error);
      return clientError(error, 'Failed to save calendar settings');
    }
  } },

  // The device scope (0.29, F5): the settings of the device the request comes
  // from, never another's. Installation state, never restored, so no restore
  // locks them; a device without the app lock its policies require reaches
  // them to set the lock up.
  'GET /api/settings/values/device': { auth: 'user', module: null, appLock: 'exempt', handler: async (req: Request, userId: string) => {
    try {
      const { deviceId } = await currentDevice(userId, getAuthTokenFromRequest(req));
      return { device_id: deviceId, settings: await getSettings('device', userId, deviceId) } satisfies DeviceSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Get device settings error:', error);
      return clientError(error, 'Failed to load the settings of this device');
    }
  } },
  'PUT /api/settings/values/device': { auth: 'user', module: null, restoreSection: null, appLock: 'exempt', handler: async (req: Request, userId: string, body: Input) => {
    try {
      const { deviceId } = await currentDevice(userId, getAuthTokenFromRequest(req));
      return { device_id: deviceId, settings: await updateSettings('device', userId, deviceId, body) } satisfies DeviceSettingsResponse;
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update device settings error:', error);
      return clientError(error, 'Failed to save the settings of this device');
    }
  } },

  // The four preferences before the registry, for clients from before 0.24.
  'GET /api/settings/preferences': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    try {
      return { preferences: await getUserPreferences(userId) };
    } catch (error) {
      console.error('Get preferences error:', error);
      return { error: 'Failed to load preferences', status: 500 };
    }
  } },

  'PUT /api/settings/preferences': { auth: 'user', module: null, restoreSection: 'settings', handler: async (req: Request, userId: string, body: Input) => {
    try {
      return await setUserPreferences(userId, body || {});
    } catch (error) {
      console.error('Update preferences error:', error);
      return { error: 'Failed to update preferences', status: 500 };
    }
  } },

  // Deleting one's own account asks for the password again: a stolen or
  // unattended session must not remove everything (security/reauthentication.ts).
  'DELETE /api/settings/account': { auth: 'user', module: null, restoreSection: '*', destructive: ['account.delete'], body: { limit: 4096 }, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {
    try {
      const confirmed = await confirmPasswordHash(userId, body?.current_password, res, OWN_CODES);
      if ('refused' in confirmed) return confirmed.refused;
      // The deletion may wait (the person's lock); its final step asks again
      // that this session is live and the password still the one entered.
      await asCaller({ userId, token: getAuthTokenFromRequest(req), passwordHash: confirmed.passwordHash },
        () => deleteUser(userId, { actor: 'self', actorId: userId, req }));
      clearAuthCookie(res);
      clearCsrfCookie(res);
      return { deleted: true };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Delete account error:', error);
      return clientError(error, 'Failed to delete account');
    }
  } },

  // Clearing a module's data follows that module's switch and its restore lock.
  // It deletes for good (data.clear, also forbidden while bin.delete is), and
  // clearing calendar or mail removes the module's accounts as well
  // (services/data-clear.ts, shared with the administrator's path).
  'POST /api/settings/clear-contacts': clearRoute('contacts', ['data.clear']),
  'POST /api/settings/clear-calendar': clearRoute('calendar', ['data.clear', 'accounts.remove']),
  'POST /api/settings/clear-mail-accounts': clearRoute('mail-accounts', ['data.clear', 'accounts.remove', 'accounts.reset']),
  'POST /api/settings/clear-recordings': clearRoute('recordings', ['data.clear']),
  'GET /api/settings/mail-sender-candidates': { auth: 'user', module: 'mail', handler: async (req: Request, userId: string) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const requestedDomainLimit = Number.parseInt(url.searchParams.get('domain_limit') || '20', 10);
      const requestedSenderLimit = Number.parseInt(url.searchParams.get('sender_limit') || '20', 10);
      const domainLimit = Number.isFinite(requestedDomainLimit) ? Math.min(Math.max(requestedDomainLimit, 1), 200) : 20;
      const senderLimit = Number.isFinite(requestedSenderLimit) ? Math.min(Math.max(requestedSenderLimit, 1), 200) : 20;
      const accountId = (url.searchParams.get('account_id') || '').trim();

      const domainWhere = ['user_id = ?', "from_address IS NOT NULL", "TRIM(from_address) <> ''", "from_address LIKE '%@%'"];
      const domainParams = [userId];
      if (accountId) {
        domainWhere.push('mail_account_id = ?');
        domainParams.push(accountId);
      }

      const senderWhere = ['user_id = ?', "from_address IS NOT NULL", "TRIM(from_address) <> ''"];
      const senderParams = [userId];
      if (accountId) {
        senderWhere.push('mail_account_id = ?');
        senderParams.push(accountId);
      }

      const [domains] = await db.execute<RowDataPacket[]>(
        `SELECT
           LOWER(TRIM(SUBSTRING_INDEX(from_address, '@', -1))) AS domain,
           COUNT(*) AS email_count,
           MAX(received_at) AS last_received_at
         FROM emails
         WHERE ${domainWhere.join(' AND ')}
         GROUP BY domain
         ORDER BY email_count DESC, last_received_at DESC
         LIMIT ${domainLimit}`,
        domainParams
      );

      const [senders] = await db.execute<RowDataPacket[]>(
        `SELECT
           LOWER(TRIM(from_address)) AS sender_email,
           MAX(NULLIF(TRIM(from_name), '')) AS sender_name,
           COUNT(*) AS email_count,
           MAX(received_at) AS last_received_at
         FROM emails
         WHERE ${senderWhere.join(' AND ')}
         GROUP BY sender_email
         ORDER BY email_count DESC, last_received_at DESC
         LIMIT ${senderLimit}`,
        senderParams
      );

      const activeRules = await loadActiveMailSenderRules(userId, accountId || null, db);
      const domainRows = (domains || []).map((domainRow) => {
        const normalizedDomain = String(domainRow.domain || '').trim().toLowerCase();
        const rule = pickBestMailSenderRuleMatch(activeRules, accountId || null, '', normalizedDomain);
        return {
          ...domainRow,
          has_rule: rule ? 1 : 0,
          matching_rule: rule || null,
        };
      });
      const senderRows = (senders || []).map((senderRow) => {
        const normalizedSenderEmail = String(senderRow.sender_email || '').trim().toLowerCase();
        const normalizedSenderDomain = normalizeSenderDomain(normalizedSenderEmail);
        const rule = pickBestMailSenderRuleMatch(activeRules, accountId || null, normalizedSenderEmail, normalizedSenderDomain);
        return {
          ...senderRow,
          has_rule: rule ? 1 : 0,
          matching_rule: rule || null,
        };
      });

      return {
        domains: domainRows,
        senders: senderRows,
        meta: {
          domain_limit: domainLimit,
          sender_limit: senderLimit,
          account_id: accountId || null,
        },
      };
    } catch (error) {
      console.error('Mail sender candidate query error:', error);
      return { error: 'Failed to load sender/domain candidates', status: 500 };
    }
  } },
});
