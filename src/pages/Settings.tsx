import { lazy, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useModules } from '@/hooks/use-modules';
import { LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SETTINGS_SECTIONS, settingsSectionFrom } from '@/components/settings/settings-sections';
import GeneralSettings from '@/components/settings/GeneralSettings';
import AppearanceSettings from '@/components/settings/AppearanceSettings';
import AccountSettings from '@/components/settings/AccountSettings';
import SecuritySettings from '@/components/settings/SecuritySettings';
import NotificationSettings from '@/components/pwa/NotificationSettings';
import OfflineSettings from '@/components/offline/OfflineSettings';
import ModuleSettings from '@/components/settings/ModuleSettings';
import MailRuleSettings from '@/components/settings/MailRuleSettings';
import DeleteDataSettings from '@/components/settings/DeleteDataSettings';

const BackupSettings = lazy(() => import('@/components/settings/BackupSettings'));

const SECTION_VIEWS = {
  general: GeneralSettings,
  appearance: AppearanceSettings,
  account: AccountSettings,
  security: SecuritySettings,
  notifications: NotificationSettings,
  offline: OfflineSettings,
  pages: ModuleSettings,
  mail: MailRuleSettings,
  delete: DeleteDataSettings,
} as const;

const Settings = () => {
  const [params] = useSearchParams();
  const { isEnabled } = useModules();
  const section = settingsSectionFrom(params, id => {
    const module = SETTINGS_SECTIONS.find(entry => entry.id === id)?.module;
    return !module || isEnabled(module);
  });
  const label = SETTINGS_SECTIONS.find(entry => entry.id === section)?.label;

  // Backup jobs keep polling while the page is open, so the section stays
  // mounted (hidden) once visited instead of restarting on every visit.
  const [backupVisited, setBackupVisited] = useState(section === 'backup');
  useEffect(() => { if (section === 'backup') setBackupVisited(true); }, [section]);

  const View = section === 'backup' ? null : SECTION_VIEWS[section];

  return (
    <PageShell panel={<SettingsPanel active={section} />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope={label} />
      <PageBody width="reading">
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
