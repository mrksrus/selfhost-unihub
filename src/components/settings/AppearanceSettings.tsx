import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { ACCENTS, accentForeground, type AccentId } from '@/lib/accent';
import { usePreferences } from '@/hooks/use-preferences';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/ui/page-states';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

const THEMES = [{ value: 'dark', label: 'Dark', icon: Moon }, { value: 'light', label: 'Light', icon: Sun }, { value: 'system', label: 'System', icon: Monitor }] as const;

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md bg-muted p-0.5">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => setTheme(value)}
          className={cn('inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-10',
            theme === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <Icon aria-hidden="true" className="h-4 w-4" />{label}
        </button>
      ))}
    </div>
  );
}

/** Swatches in the colour each accent has in the theme in force. */
function AccentPicker({ value, onChange, disabled }: { value: AccentId; onChange: (id: AccentId) => void; disabled: boolean }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  return (
    <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2">
      {ACCENTS.map(accent => {
        const selected = accent.id === value;
        return (
          <button key={accent.id} type="button" role="radio" aria-checked={selected} aria-label={accent.label} title={accent.label} disabled={disabled}
            onClick={() => onChange(accent.id)}
            className={cn('tap-area flex h-8 w-8 items-center justify-center rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50',
              selected ? 'scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'hover:scale-105')}
            style={{ backgroundColor: `hsl(${dark ? accent.dark : accent.light})`, color: `hsl(${accentForeground(accent.id, dark)})` }}>
            {selected && <Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

export default function AppearanceSettings() {
  const { preferences, change, unavailable, error, refetch, refetching } = usePreferences();
  return (
    <>
      <SettingsSection title="Theme">
        <SettingsRow label="Theme" description="Dark, light, or whatever the device uses.">
          <ThemeSwitch />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Colour">
        {error && (
          <div className="py-4">
            <ErrorState title="Could not load your preferences" error={error} onRetry={refetch} retrying={refetching} />
          </div>
        )}
        <SettingsRow label="Accent colour" description="Buttons, links, the selected page and the UniHub mark. Saved with your account, so every device follows.">
          <AccentPicker value={preferences.accent_color} disabled={unavailable} onChange={id => change({ accent_color: id })} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
