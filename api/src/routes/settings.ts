import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import { db } from '../state';
import { clearAuthCookie, clearCsrfCookie } from '../auth';
import { clientError } from '../http/errors';
import { ensureDefaultLocalCalendarForUser } from '../services/calendar';
import {
  deleteStoredAttachmentFiles,
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  normalizeSenderDomain,
} from '../services/mail';
import {
  deleteRecordingFiles,
} from '../services/recordings';
import { deleteUser } from '../services/user-lifecycle';
import { getScopedSettings, getSettings, getUserPreferences, setUserPreferences, updateSettings } from '../services/settings';
import type {
  CalendarSettingsResponse,
  CalendarSettingValues,
  MailAccountSettingsResponse,
  MailAccountSettingValues,
  ScopedSettingsResponse,
  UserSettingsResponse,
} from '../contracts/settings';
import { defineRoutes } from '../http/route';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = Record<string, unknown>;

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
      return { settings: await updateSettings('user', userId, userId, body) } satisfies UserSettingsResponse;
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

  'DELETE /api/settings/account': { auth: 'user', module: null, restoreSection: '*', handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {
    try {
      await deleteUser(userId, { actor: 'self', actorId: userId, req });
      clearAuthCookie(res);
      clearCsrfCookie(res);
      return { deleted: true };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Delete account error:', error);
      return clientError(error, 'Failed to delete account');
    }
  } },

  // Clearing a module's data follows that module's switch and its restore lock.
  'POST /api/settings/clear-contacts': { auth: 'user', module: 'contacts', restoreSection: 'contacts', handler: async (req: Request, userId: string) => {
    try {
      const [result] = await db.execute<ResultSetHeader>('DELETE FROM contacts WHERE user_id = ?', [userId]);
      const deleted = result.affectedRows || 0;
      return { message: `Deleted ${deleted} contact(s)`, deleted };
    } catch (error) {
      console.error('Clear contacts error:', error);
      return { error: 'Failed to delete contacts', status: 500 };
    }
  } },
  'POST /api/settings/clear-calendar': { auth: 'user', module: 'calendar', restoreSection: 'calendar', handler: async (req: Request, userId: string) => {
    try {
      const [subtasksResult] = await db.execute<ResultSetHeader>('DELETE FROM calendar_event_subtasks WHERE user_id = ?', [userId]);
      const [eventsResult] = await db.execute<ResultSetHeader>('DELETE FROM calendar_events WHERE user_id = ?', [userId]);
      await db.execute('DELETE FROM calendar_calendars WHERE user_id = ?', [userId]);
      await db.execute('DELETE FROM calendar_accounts WHERE user_id = ?', [userId]);
      await ensureDefaultLocalCalendarForUser(userId);
      const deletedSubtasks = subtasksResult.affectedRows || 0;
      const deletedEvents = eventsResult.affectedRows || 0;
      return { message: `Deleted ${deletedEvents} event(s) and ${deletedSubtasks} subtask(s)`, deleted: deletedEvents + deletedSubtasks };
    } catch (error) {
      console.error('Clear calendar error:', error);
      return { error: 'Failed to delete calendar and todo data', status: 500 };
    }
  } },
  'POST /api/settings/clear-mail-accounts': { auth: 'user', module: 'mail', restoreSection: 'mail', handler: async (req: Request, userId: string) => {
    try {
      const [attachments] = await db.execute<RowDataPacket[]>(
        'SELECT storage_path FROM email_attachments WHERE user_id = ?',
        [userId]
      );
      // Linked calendars stay, unlinked: one connected from mail finds a mail
      // account with its address again (its sync waits until then), and its
      // running work, which read a deleted login, stops.
      const { stopCalendarAccountWork, unlinkFromDeletedMail } = require('../services/calendar-sync') as typeof import('../services/calendar-sync');
      const connection = await db.getConnection();
      let result: ResultSetHeader;
      let linkedCalendars: (RowDataPacket & { id: string; provider: string; provider_config: unknown; mail_account_id: string })[];
      try {
        await connection.beginTransaction();
        // Locking read: a sync linking a calendar meanwhile waits for the commit
        // and then finds its mail account gone.
        [linkedCalendars] = await connection.execute<typeof linkedCalendars>(`SELECT id, provider, provider_config, mail_account_id FROM calendar_accounts
          WHERE user_id = ? AND mail_account_id IS NOT NULL FOR UPDATE`, [userId]);
        [result] = await connection.execute<ResultSetHeader>('DELETE FROM mail_accounts WHERE user_id = ?', [userId]);
        for (const calendar of linkedCalendars) await unlinkFromDeletedMail(connection, calendar, calendar.mail_account_id);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      const { publishCalendarChanged } = require('../services/realtime') as typeof import('../services/realtime');
      for (const calendar of linkedCalendars) {
        if (calendar.provider === 'caldav') stopCalendarAccountWork(calendar.id, 'unlinked');
        publishCalendarChanged(userId, calendar.id, 'status');
      }
      const fileResult = await deleteStoredAttachmentFiles((attachments || []).map(row => row.storage_path));
      const deleted = result.affectedRows || 0;
      return {
        message: `Deleted ${deleted} mail account(s). Removed ${fileResult.deletedFiles} attachment file(s).`,
        deleted,
        deletedAttachmentFiles: fileResult.deletedFiles,
        failedAttachmentFiles: fileResult.failedFiles,
      };
    } catch (error) {
      console.error('Clear mail accounts error:', error);
      return { error: 'Failed to delete mail accounts', status: 500 };
    }
  } },
  'POST /api/settings/clear-recordings': { auth: 'user', module: 'recordings', restoreSection: 'recordings', handler: async (req: Request, userId: string) => {
    try {
      const [recordings] = await db.execute<RowDataPacket[]>('SELECT storage_path FROM recordings WHERE user_id = ?', [userId]);
      for (const row of recordings || []) {
        await deleteRecordingFiles(row.storage_path);
      }
      const [result] = await db.execute<ResultSetHeader>('DELETE FROM recordings WHERE user_id = ?', [userId]);
      return { message: `Deleted ${result.affectedRows || 0} recording(s)`, deleted: result.affectedRows || 0 };
    } catch (error) {
      console.error('Clear recordings error:', error);
      return { error: 'Failed to delete recordings', status: 500 };
    }
  } },
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
