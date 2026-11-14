import { MyGroups } from '@/components/organisation/MyGroups';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';

/** Your groups, as a page of its own for people who manage one (Settings panel and More). */
const MyGroupsPage = () => (
  <PageShell panel={<SettingsPanel active="groups" />} panelLabel="Settings sections" panelId="settings">
    <PageHeader title="Settings" scope="Your groups" />
    <PageBody width="reading"><MyGroups /></PageBody>
  </PageShell>
);

export default MyGroupsPage;
