import { lazy, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useModules } from '@/hooks/use-modules';
import { useAppLock } from '@/hooks/use-app-lock';
import { LockScreen } from '@/components/app-lock/LockScreen';
import { AppLockRequiredPrompt } from '@/components/app-lock/AppLockRequiredPrompt';
import { LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SETTINGS_SECTIONS, settingsSectionFrom } from '@/components/settings/settings-sections';
import GeneralSettings from '@/components/settings/GeneralSettings';
import AppearanceSettings from '@/components/settings/AppearanceSettings';
import AccountSettings from '@/components/settings/AccountSettings';
import SecuritySettings from '@/components/settings/SecuritySettings';
import AppLockSettings from '@/components/settings/AppLockSettings';
import NotificationSettings from '@/components/pwa/NotificationSettings';
import { NotificationChoices } from '@/components/settings/NotificationChoices';
import OfflineSettings from '@/components/offline/OfflineSettings';
import ModuleSettings from '@/components/settings/ModuleSettings';
import MailSettings from '@/components/settings/MailSettings';
import MailRuleSettings from '@/components/settings/MailRuleSettings';
import DeleteDataSettings from '@/components/settings/DeleteDataSettings';
import BinSettings from '@/components/settings/BinSettings';

const BackupSettings = lazy(() => import('@/components/settings/BackupSettings'));

// This device first, then what is announced per account and calendar.
function NotificationsSection() {
  return <><NotificationSettings /><NotificationChoices /></>;
}

const SECTION_VIEWS = {
  general: GeneralSettings,
  appearance: AppearanceSettings,
  account: AccountSettings,
  security: SecuritySettings,
  'app-lock': AppLockSettings,
  notifications: NotificationsSection,
  offline: OfflineSettings,
  pages: ModuleSettings,
  mail: MailSettings,
  'mail-rules': MailRuleSettings,
  bin: BinSettings,
  delete: DeleteDataSettings,
} as const;

const Settings = () => {
  const [params] = useSearchParams();
  const { isEnabled } = useModules();
  const lock = useAppLock();
  const section = settingsSectionFrom(params, id => {
    const module = SETTINGS_SECTIONS.find(entry => entry.id === id)?.module;
    return !module || isEnabled(module);
  });
  const entry = SETTINGS_SECTIONS.find(entry => entry.id === section);
  const label = entry?.label;
  // A section of a locked module asks for the unlock in place; Backup and
  // restore and Delete data reach every module, so they ask while any lock is on.
  const reachesEverything = section === 'backup' || section === 'delete';
  const lockedArea = entry?.module && lock.locked(entry.module) ? entry.module
    : reachesEverything && (lock.status === 'locked' || lock.status === 'setup') ? 'app' : null;

  // Backup jobs keep polling while the page is open, so the section stays
  // mounted (hidden) once visited instead of restarting on every visit.
  const [backupVisited, setBackupVisited] = useState(section === 'backup' && !lockedArea);
  useEffect(() => { if (section === 'backup' && !lockedArea) setBackupVisited(true); }, [section, lockedArea]);

  const View = section === 'backup' || lockedArea ? null : SECTION_VIEWS[section];

  return (
    <PageShell panel={<SettingsPanel active={section} />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={label} />
      <PageBody width="reading">
        {lockedArea && (lock.status === 'setup'
          ? <AppLockRequiredPrompt area={lockedArea} variant="inline" />
          : <LockScreen area={lockedArea} variant="inline" title={lockedArea === 'app' ? 'Unlock to continue' : undefined}
              description={lockedArea === 'app' ? `${label} reaches what the app lock protects.` : undefined} />)}
        {View && <View />}
        {backupVisited && (
          <div hidden={section !== 'backup'}>
            <Suspense fallback={<LoadingState compact label="Loading backup settings…" />}>
              <BackupSettings active={section === 'backup'} />
            </Suspense>
          </div>
        )}
      </PageBody>
    </PageShell>
  );
};

export default Settings;
