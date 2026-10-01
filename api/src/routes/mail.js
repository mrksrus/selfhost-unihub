// Mail routes, grouped by area. request-handler.js dispatches on the same
// 'METHOD /path' keys; routes/index.js spreads this object.
module.exports = {
  ...require('./mail-folders'),
  ...require('./mail-accounts'),
  ...require('./mail-drafts'),
  ...require('./mail-messages'),
  ...require('./mail-operations'),
  ...require('./mail-sync'),
};
