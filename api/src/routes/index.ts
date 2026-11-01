import systemRoutes = require('./system');
import modulesRoutes = require('./modules');
import authRoutes = require('./auth');
import contactsRoutes = require('./contacts');
import contactsTransferRoutes = require('./contacts-transfer');
import contactsPhotosRoutes = require('./contacts-photos');
import contactsMergeRoutes = require('./contacts-merge');
import settingsRoutes = require('./settings');
import backupRoutes = require('./backup');
import searchRoutes = require('./search');
import recordingsRoutes = require('./recordings');
import calendarRoutes = require('./calendar');
import calendarTasksRoutes = require('./calendar-tasks');
import mailRoutes = require('./mail');
import mailEssentialsRoutes = require('./mail-essentials');
import mailThreadsRoutes = require('./mail-threads');
import adminRoutes = require('./admin');
import notificationsRoutes = require('./notifications');
import offlineRoutes = require('./offline');
import eventsRoutes = require('./events');
import filesRoutes = require('./files');
import { assertRouteTable, mergeRouteTables } from '../http/route';
import { legacyRoutes } from './legacy-spec';
import { MODULE_CATALOG } from '../services/module-catalog';
import { SECTION_POLICIES } from '../services/backup-catalog';
import { POLICIES } from '../services/settings';

// The production route table: every key once, each with its spec. Files still
// exporting plain handlers are wrapped with the derived legacy policy.
const routes = mergeRouteTables(
  systemRoutes,
  modulesRoutes,
  authRoutes,
  contactsRoutes,
  contactsTransferRoutes,
  contactsPhotosRoutes,
  contactsMergeRoutes,
  settingsRoutes,
  legacyRoutes(backupRoutes),
  searchRoutes,
  legacyRoutes(recordingsRoutes),
  legacyRoutes(calendarRoutes),
  calendarTasksRoutes,
  legacyRoutes(mailRoutes),
  mailEssentialsRoutes,
  mailThreadsRoutes,
  adminRoutes,
  notificationsRoutes,
  offlineRoutes,
  eventsRoutes,
  filesRoutes,
);
// A route declares only policy keys that can refuse an action.
const refusablePolicies = Object.entries(POLICIES).filter(([, entry]) => entry.refuses.length).map(([key]) => key);
assertRouteTable(routes, { moduleIds: MODULE_CATALOG.map(module => module.id), sections: Object.keys(SECTION_POLICIES), policyKeys: refusablePolicies });

export = routes;
