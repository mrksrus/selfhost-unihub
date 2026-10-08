import systemRoutes = require('./system');
import modulesRoutes = require('./modules');
import authRoutes = require('./auth');
import contactsRoutes = require('./contacts');
import settingsRoutes = require('./settings');
import backupRoutes = require('./backup');
import searchRoutes = require('./search');
import recordingsRoutes = require('./recordings');
import calendarRoutes = require('./calendar');
import mailRoutes = require('./mail');
import adminRoutes = require('./admin');
import notificationsRoutes = require('./notifications');
import offlineRoutes = require('./offline');
import eventsRoutes = require('./events');

export = {
  ...systemRoutes,
  ...modulesRoutes,
  ...authRoutes,
  ...contactsRoutes,
  ...settingsRoutes,
  ...backupRoutes,
  ...searchRoutes,
  ...recordingsRoutes,
  ...calendarRoutes,
  ...mailRoutes,
  ...adminRoutes,
  ...notificationsRoutes,
  ...offlineRoutes,
  ...eventsRoutes,
};
