const { getUserModules, setUserModules } = require('../services/module-settings');
module.exports = {
  'GET /api/modules': async (_req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    return { modules: await getUserModules(userId) };
  },
  'PUT /api/modules': async (_req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const modules = await setUserModules(userId, body);
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
          // without clearing it. Only queued/running read work is dropped.
          for (const account of accounts) {
            if (Number(account.is_active) && !account.disconnected_at)
              await require('../services/mail-engine/runtime').resumeAccount({ userId, accountId: account.id,
                resumeStreams: mail.background, reasons: USER_PAUSES });
            if (!mail.background) await cancelMailAccountSync(account.id);
          }
        }
      }
      return { modules };
    }
    catch (error) { if (error.status === 400) return { error: error.message, status: 400 }; throw error; }
  },
};
