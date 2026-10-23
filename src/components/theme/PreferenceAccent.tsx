import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { useAccent } from '@/components/theme/use-accent';

/** Applies the signed-in user's saved accent; nothing changes until the preference is known. */
export function PreferenceAccent() {
  const { data: saved } = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('accent_color') });
  const { accent, setAccent } = useAccent();
  useEffect(() => { if (saved && saved !== accent) setAccent(saved); }, [saved, accent, setAccent]);
  return null;
}
