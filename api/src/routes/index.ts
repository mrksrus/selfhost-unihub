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
import { assertRouteTable, mergeRouteTables } from '../http/route';
import { legacyRoutes } from './legacy-spec';
import { MODULE_CATALOG } from '../services/module-catalog';

// The production route table: every key once, each with its spec. Files still
// exporting plain handlers are wrapped with the derived legacy policy.
const routes = mergeRouteTables(
  legacyRoutes(systemRoutes),
  legacyRoutes(modulesRoutes),
  legacyRoutes(authRoutes),
  legacyRoutes(contactsRoutes),
  legacyRoutes(settingsRoutes),
  legacyRoutes(backupRoutes),
  legacyRoutes(searchRoutes),
  legacyRoutes(recordingsRoutes),
  legacyRoutes(calendarRoutes),
  legacyRoutes(mailRoutes),
  legacyRoutes(adminRoutes),
  notificationsRoutes,
  legacyRoutes(offlineRoutes),
  legacyRoutes(eventsRoutes),
);
assertRouteTable(routes, { moduleIds: MODULE_CATALOG.map(module => module.id) });

export = routes;
