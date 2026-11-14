import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { can, managesGroups } from '@/lib/permissions';
import { PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { MY_GROUPS_PAGE, SERVER_PAGES, SETTINGS_SECTIONS, settingsHref } from '@/components/settings/settings-sections';

/**
 * The settings sections, "Your groups" for a person who manages one, and
 * the Server pages the person's permissions open. Shared by Settings and
 * the Server pages.
 */
export function SettingsPanel({ active }: { active: string }) {
  const { user } = useAuth();
  const { isEnabled } = useModules();
  const server = SERVER_PAGES.filter(page => can(user, page.permission));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Settings" />
      <PanelGroup>
        {SETTINGS_SECTIONS.filter(section => !section.module || isEnabled(section.module)).map(section => (
          <PanelItem key={section.id} icon={section.icon} href={settingsHref(section.id)} active={active === section.id}>{section.label}</PanelItem>
        ))}
        {managesGroups(user) && <PanelItem icon={MY_GROUPS_PAGE.icon} href={MY_GROUPS_PAGE.href} active={active === MY_GROUPS_PAGE.id}>{MY_GROUPS_PAGE.label}</PanelItem>}
      </PanelGroup>
      {server.length > 0 && (
        <PanelGroup label="Server" className="border-t border-border pt-3">
          {server.map(page => <PanelItem key={page.id} icon={page.icon} href={page.href} active={active === page.id}>{page.label}</PanelItem>)}
        </PanelGroup>
      )}
    </div>
  );
}
