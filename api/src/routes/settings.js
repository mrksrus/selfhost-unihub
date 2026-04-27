const { db } = require('../state');
const { ensureDefaultLocalCalendarForUser } = require('../services/calendar');
const {
  deleteStoredAttachmentFiles,
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  normalizeSenderDomain,
} = require('../services/mail');


module.exports = {
  // User data management: clear all for current user
  'POST /api/settings/clear-contacts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const [result] = await db.execute('DELETE FROM contacts WHERE user_id = ?', [userId]);
      const deleted = result.affectedRows || 0;
      return { message: `Deleted ${deleted} contact(s)`, deleted };
    } catch (error) {
      console.error('Clear contacts error:', error);
      return { error: 'Failed to delete contacts', status: 500 };
    }
  },
  'POST /api/settings/clear-calendar': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const [subtasksResult] = await db.execute('DELETE FROM calendar_event_subtasks WHERE user_id = ?', [userId]);
      const [eventsResult] = await db.execute('DELETE FROM calendar_events WHERE user_id = ?', [userId]);
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
  },
  'POST /api/settings/clear-mail-accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const [attachments] = await db.execute(
        'SELECT storage_path FROM email_attachments WHERE user_id = ?',
        [userId]
      );
      const [result] = await db.execute('DELETE FROM mail_accounts WHERE user_id = ?', [userId]);
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
  },
  'GET /api/settings/mail-sender-candidates': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
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

      const [domains] = await db.execute(
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

      const [senders] = await db.execute(
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
  },
};
