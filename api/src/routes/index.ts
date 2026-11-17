import systemRoutes = require('./system');
import modulesRoutes = require('./modules');
import authRoutes = require('./auth');
import devicesRoutes = require('./devices');
import contactsRoutes = require('./contacts');
import contactsTransferRoutes = require('./contacts-transfer');
import contactsPhotosRoutes = require('./contacts-photos');
import contactsMergeRoutes = require('./contacts-merge');
import addressBooksRoutes = require('./address-books');
import directoryRoutes = require('./directory');
import settingsRoutes = require('./settings');
import backupRoutes = require('./backup');
import searchRoutes = require('./search');
import recordingsRoutes = require('./recordings');
import calendarRoutes = require('./calendar');
import calendarTasksRoutes = require('./calendar-tasks');
import calendarSharesRoutes = require('./calendar-shares');
import mailRoutes = require('./mail');
import mailEssentialsRoutes = require('./mail-essentials');
import mailThreadsRoutes = require('./mail-threads');
import adminRoutes = require('./admin');
import adminInstanceBackupRoutes = require('./admin-instance-backup');
import notificationsRoutes = require('./notifications');
import offlineRoutes = require('./offline');
import eventsRoutes = require('./events');
import filesRoutes = require('./files');
import binRoutes = require('./bin');
import policiesRoutes = require('./policies');
import adminPeopleRoutes = require('./admin-people');
import groupsRoutes = require('./groups');
import invitesRoutes = require('./invites');
import widgetsRoutes = require('./widgets');
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
  devicesRoutes,
  contactsRoutes,
  contactsTransferRoutes,
  contactsPhotosRoutes,
  contactsMergeRoutes,
  addressBooksRoutes,
  directoryRoutes,
  settingsRoutes,
  backupRoutes,
  searchRoutes,
  legacyRoutes(recordingsRoutes),
  legacyRoutes(calendarRoutes),
  calendarTasksRoutes,
  calendarSharesRoutes,
  legacyRoutes(mailRoutes),
  mailEssentialsRoutes,
  mailThreadsRoutes,
  adminRoutes,
  adminInstanceBackupRoutes,
  notificationsRoutes,
  offlineRoutes,
  eventsRoutes,
  filesRoutes,
  binRoutes,
  policiesRoutes,
  adminPeopleRoutes,
  groupsRoutes,
  invitesRoutes,
  widgetsRoutes,
);
// A route declares only policy keys that can refuse an action.
const refusablePolicies = Object.entries(POLICIES).filter(([, entry]) => entry.refuses.length).map(([key]) => key);
assertRouteTable(routes, { moduleIds: MODULE_CATALOG.map(module => module.id), sections: Object.keys(SECTION_POLICIES), policyKeys: refusablePolicies });

export = routes;
