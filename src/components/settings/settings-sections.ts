import { Archive, Bell, CloudOff, LayoutGrid, ListFilter, Shield, SlidersHorizontal, Trash2, UserRound } from 'lucide-react';
import type { ModuleId } from '@/lib/modules';

export type SettingsSectionId = 'general' | 'account' | 'security' | 'notifications' | 'offline' | 'pages' | 'mail' | 'backup' | 'delete';

export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; icon: typeof Bell; module?: ModuleId }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'account', label: 'Profile', icon: UserRound },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'offline', label: 'Offline reading', icon: CloudOff },
  { id: 'pages', label: 'Pages and modules', icon: LayoutGrid },
  { id: 'mail', label: 'Mail rules', icon: ListFilter, module: 'mail' },
  { id: 'backup', label: 'Backup and restore', icon: Archive },
  { id: 'delete', label: 'Delete data', icon: Trash2 },
];

// Links from before 0.19.2 used ?tab=.
const LEGACY_TABS: Record<string, SettingsSectionId> = { general: 'general', modules: 'pages', security: 'security', data: 'backup', mail: 'mail', danger: 'delete' };

export function settingsSectionFrom(params: URLSearchParams, available: (id: SettingsSectionId) => boolean): SettingsSectionId {
  const requested = params.get('section') ?? LEGACY_TABS[params.get('tab') ?? ''];
  const section = SETTINGS_SECTIONS.find(entry => entry.id === requested)?.id;
  return section && available(section) ? section : 'general';
}

export const settingsHref = (id: SettingsSectionId) => id === 'general' ? '/settings' : `/settings?section=${id}`;
