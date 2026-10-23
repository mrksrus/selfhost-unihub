import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { ACCENTS, accentChannels, accentForeground, type AccentId } from '@/lib/accent';
import { DEFAULT_THEME, themesFor, type Theme, type ThemeMode } from '@/lib/theme';
import { useUserSettings } from '@/hooks/use-settings';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { useAccent } from '@/components/theme/use-accent';
import { useLook } from '@/components/theme/use-look';

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

/** A small page in the look's own colours: the stylesheet's variables apply to the mode class and data-theme. */
function LookSwatch({ theme, accent }: { theme: Theme; accent: AccentId }) {
  const dark = theme.mode === 'dark';
  return (
    <span aria-hidden="true" className={cn(theme.mode, 'flex h-14 w-full overflow-hidden rounded-md border border-border bg-background')}
      data-theme={theme.id === DEFAULT_THEME ? undefined : theme.id} style={{ colorScheme: theme.mode }}>
      <span className="flex w-7 shrink-0 flex-col items-center gap-1 border-r border-border bg-card pt-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: `hsl(${accentChannels(accent, dark, theme)})` }} />
        <span className="h-2.5 w-2.5 rounded-full bg-muted" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <span className="h-1.5 w-1/2 rounded-full bg-foreground" />
        <span className="h-1.5 w-full rounded-full bg-muted-foreground/60" />
        <span className="mt-auto flex gap-1">
          <span className="h-1.5 w-4 rounded-full bg-warning" /><span className="h-1.5 w-4 rounded-full bg-success" /><span className="h-1.5 w-4 rounded-full bg-destructive" />
        </span>
      </span>
    </span>
  );
}

/** The looks of one mode, as live swatches; the choice is saved on this device. */
function LookPicker({ mode }: { mode: ThemeMode }) {
  const { looks, setLook } = useLook();
  const { accent } = useAccent();
  return (
    <div role="radiogroup" aria-label={`${mode === 'dark' ? 'Dark' : 'Light'} look`} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {themesFor(mode).map(theme => {
        const selected = looks[mode] === theme.id;
        return (
          <button key={theme.id} type="button" role="radio" aria-checked={selected} onClick={() => setLook(mode, theme.id)}
            className={cn('flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              selected ? 'border-foreground' : 'border-border hover:border-muted-foreground')}>
            <LookSwatch theme={theme} accent={accent} />
            <span className="flex items-center justify-between gap-2 px-0.5 text-sm font-medium">
              {theme.label}{selected && <Check aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={2.5} />}
            </span>
            <span className="px-0.5 text-xs text-muted-foreground">{theme.purpose}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Swatches in the colour each accent has in the theme in force. */
function AccentPicker({ value, onChange, disabled }: { value: AccentId; onChange: (id: AccentId) => void; disabled: boolean }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  return (
    <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2 touch:gap-3">
      {ACCENTS.map(accent => {
        const selected = accent.id === value;
        return (
          <button key={accent.id} type="button" role="radio" aria-checked={selected} aria-label={accent.label} title={accent.label} disabled={disabled}
            onClick={() => onChange(accent.id)}
            className={cn('tap-area flex h-8 w-8 items-center justify-center rounded-full touch:h-10 touch:w-10 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50',
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
  const { values: preferences, change, unavailable, error, refetch, refetching } = useUserSettings();
  const { theme, resolvedTheme } = useTheme();
  const mode: ThemeMode = resolvedTheme === 'light' ? 'light' : 'dark';
  return (
    <>
      <SettingsSection title="Theme">
        <SettingsRow label="Theme" description="Dark, light, or whatever the device uses.">
          <ThemeSwitch />
        </SettingsRow>
        <SettingsBlock>
          <p className="text-sm font-medium">{mode === 'dark' ? 'Dark look' : 'Light look'}</p>
          <p className="mb-3 mt-0.5 text-sm text-muted-foreground">
            Saved on this device.{theme === 'system' && ` The ${mode === 'dark' ? 'light' : 'dark'} theme has its own look; it shows when the device switches.`}
          </p>
          <LookPicker mode={mode} />
        </SettingsBlock>
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
