import { Server, Users } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { SETTINGS_SECTIONS, settingsHref } from '@/components/settings/settings-sections';

/** The settings sections, plus the server pages for admins. Shared by Settings and the admin pages. */
export function SettingsPanel({ active }: { active: string }) {
  const { user } = useAuth();
  const { isEnabled } = useModules();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader title="Settings" />
      <PanelGroup>
        {SETTINGS_SECTIONS.filter(section => !section.module || isEnabled(section.module)).map(section => (
          <PanelItem key={section.id} icon={section.icon} href={settingsHref(section.id)} active={active === section.id}>{section.label}</PanelItem>
        ))}
      </PanelGroup>
      {user?.role === 'admin' && (
        <PanelGroup label="Server" className="border-t border-border pt-3">
          <PanelItem icon={Server} href="/admin/settings" active={active === 'admin-settings'}>Server settings</PanelItem>
          <PanelItem icon={Users} href="/admin/users" active={active === 'admin-users'}>Users</PanelItem>
        </PanelGroup>
      )}
    </div>
  );
}
