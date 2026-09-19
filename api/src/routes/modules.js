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
      if (body.modules?.mail?.enabled === false || body.modules?.mail?.background === false) {
        const { db } = require('../state');
        const { cancelMailAccountSync } = require('../services/mail');
        const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE user_id = ?', [userId]);
        for (const account of accounts) cancelMailAccountSync(account.id);
      }
      return { modules };
    }
    catch (error) { if (error.status === 400) return { error: error.message, status: 400 }; throw error; }
  },
};
