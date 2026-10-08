import routes0 = require('./mail-folders');
import routes1 = require('./mail-accounts');
import routes2 = require('./mail-drafts');
import routes3 = require('./mail-messages');
import routes4 = require('./mail-operations');
import routes5 = require('./mail-sync');
// Mail routes, grouped by area. request-handler.js dispatches on the same
// 'METHOD /path' keys; routes/index.js spreads this object.
export = {
  ...routes0,
  ...routes1,
  ...routes2,
  ...routes3,
  ...routes4,
  ...routes5,
};
