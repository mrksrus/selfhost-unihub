// Mail routes, grouped by area. request-handler.ts dispatches on the same
// 'METHOD /path' keys; routes/index.ts spreads this object.
import mailFoldersRoutes = require('./mail-folders');
import mailAccountsRoutes = require('./mail-accounts');
import mailDraftsRoutes = require('./mail-drafts');
import mailMessagesRoutes = require('./mail-messages');
import mailOperationsRoutes = require('./mail-operations');
import mailSyncRoutes = require('./mail-sync');

export = {
  ...mailFoldersRoutes,
  ...mailAccountsRoutes,
  ...mailDraftsRoutes,
  ...mailMessagesRoutes,
  ...mailOperationsRoutes,
  ...mailSyncRoutes,
};
