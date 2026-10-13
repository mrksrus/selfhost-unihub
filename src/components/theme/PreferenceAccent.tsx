import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { preferencesQueryOptions } from '@/lib/settings-api';
import { useAccent } from '@/components/theme/use-accent';

/** Applies the signed-in user's saved accent; nothing changes until the preference is known. */
export function PreferenceAccent() {
  const { data } = useQuery(preferencesQueryOptions);
  const { accent, setAccent } = useAccent();
  const saved = data?.accent_color;
  useEffect(() => { if (saved && saved !== accent) setAccent(saved); }, [saved, accent, setAccent]);
  return null;
}
