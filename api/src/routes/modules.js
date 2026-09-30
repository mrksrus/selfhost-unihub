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
        const { stopMailAccountWork } = require('../services/mail');
        const mail = modules.find(module => module.id === 'mail');
        const [accounts] = await db.execute('SELECT id, is_active, disconnected_at FROM mail_accounts WHERE user_id = ?', [userId]);
        if (!mail.enabled || !mail.background) {
          for (const account of accounts) await stopMailAccountWork(account.id,
            mail.enabled ? 'Mail background paused' : 'Mail module disabled');
        } else {
          for (const account of accounts) if (Number(account.is_active) && !account.disconnected_at)
            await require('../services/mail-engine/runtime').resumeAccount({ userId, accountId: account.id,
              reasons: ['Mail module disabled', 'Mail background paused'] });
        }
      }
      return { modules };
    }
    catch (error) { if (error.status === 400) return { error: error.message, status: 400 }; throw error; }
  },
};
