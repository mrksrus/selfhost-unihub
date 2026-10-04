const { getOrderedUserModules, getUserPages, setUserModules } = require('../services/module-settings');
module.exports = {
  'GET /api/modules': async (_req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    return { modules: await getOrderedUserModules(userId), pages: await getUserPages(userId) };
  },
  'PUT /api/modules': async (_req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const modules = await setUserModules(userId, body);
      require('../services/server-events').serverEvents.setUserModules(userId,
        modules.filter(module => module.enabled).map(module => module.id));
      if (body.modules?.mail) {
        const { db } = require('../state');
        const { stopMailAccountWork, cancelMailAccountSync } = require('../services/mail');
        const { USER_PAUSES } = require('../services/mail-engine/rollout');
        const mail = modules.find(module => module.id === 'mail');
        const [accounts] = await db.execute('SELECT id, is_active, disconnected_at FROM mail_accounts WHERE user_id = ?', [userId]);
        if (!mail.enabled) {
          for (const account of accounts) await stopMailAccountWork(account.id, 'Mail module disabled');
        } else {
          // Background off is a scheduling preference enforced at admission,
          // not an account fence: user Sync/flag/move work must keep running
          // without clearing it. Only queued/running background read work is
          // dropped; a requested Sync, such as a restored account's first
          // download, resumes.
          for (const account of accounts) {
            if (Number(account.is_active) && !account.disconnected_at)
              await require('../services/mail-engine/runtime').resumeAccount({ userId, accountId: account.id,
                resumeStreams: mail.background, reasons: USER_PAUSES });
            if (!mail.background) await cancelMailAccountSync(account.id, { keepManual: true });
          }
          // The IDLE session is background work: close it now, or start it
          // without waiting for the supervisor's next eligibility pass.
          const { idleSupervisor } = require('../services/mail-idle');
          if (!mail.background) for (const account of accounts) idleSupervisor.stopAccount(account.id);
          else void idleSupervisor.refresh();
        }
      }
      return { modules, pages: await getUserPages(userId) };
    }
    catch (error) { if (error.status === 400) return { error: error.message, status: 400 }; throw error; }
  },
};
