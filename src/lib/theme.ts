/**
 * Looks: alternative palettes for the dark and the light theme, chosen per
 * device. The colour channels live in src/index.css under
 * `.dark[data-theme="<id>"]` and `.light[data-theme="<id>"]`; this table only
 * names them. The default of each mode is the plain `.dark` / `.light` block.
 */
export type ThemeMode = 'dark' | 'light';

export interface Theme {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Why this look exists, shown under its swatch. */
  purpose: string;
  /** The accent is moved until text on it and on the page reaches this contrast (High contrast). */
  minContrast?: number;
}

export const DEFAULT_THEME = 'default';

export const THEMES: readonly Theme[] = [
  { id: 'default', label: 'Default', mode: 'dark', purpose: 'Black page, dark grey surfaces.' },
  { id: 'oled', label: 'OLED black', mode: 'dark', purpose: 'True black everywhere; black pixels stay off.' },
  { id: 'dim', label: 'Dim', mode: 'dark', purpose: 'Soft grey, no pure black or white, for dark rooms.' },
  { id: 'contrast', label: 'High contrast', mode: 'dark', purpose: 'Strong borders, brighter colours, thick focus outline.', minContrast: 7 },
  { id: 'colour-safe', label: 'Colour-safe', mode: 'dark', purpose: 'Warnings, errors and success tell apart with red-green colour blindness.' },
  { id: 'neon', label: 'Neon', mode: 'dark', purpose: 'Deep violet with glowing edges. Just for fun.' },
  { id: 'default', label: 'Default', mode: 'light', purpose: 'Light grey page, white surfaces.' },
  { id: 'paper', label: 'Paper', mode: 'light', purpose: 'Warm off-white and ink for long reading.' },
  { id: 'contrast', label: 'High contrast', mode: 'light', purpose: 'Black on white, strong borders, thick focus outline.', minContrast: 7 },
  { id: 'colour-safe', label: 'Colour-safe', mode: 'light', purpose: 'Warnings, errors and success tell apart with red-green colour blindness.' },
];

export const themesFor = (mode: ThemeMode) => THEMES.filter(theme => theme.mode === mode);
export const themeById = (mode: ThemeMode, id: string) => themesFor(mode).find(theme => theme.id === id) ?? themesFor(mode)[0];

// index.html reads the same keys before the first paint.
const storageKey = (mode: ThemeMode) => `unihub:theme:${mode}`;

/** The look chosen on this device for a mode; the default when none or unknown. */
export function readStoredTheme(mode: ThemeMode): string {
  try {
    return themeById(mode, localStorage.getItem(storageKey(mode)) ?? DEFAULT_THEME).id;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(mode: ThemeMode, id: string) {
  try {
    if (id === DEFAULT_THEME) localStorage.removeItem(storageKey(mode));
    else localStorage.setItem(storageKey(mode), id);
  } catch { /* Storage may be disabled. */ }
}

/** Marks the page with the look so the stylesheet's `[data-theme]` blocks apply. */
export function applyTheme(mode: ThemeMode, id: string) {
  const root = document.documentElement;
  if (id === DEFAULT_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  // The page colour as the stylesheet resolves it for this look; the plain
  // defaults when no stylesheet is loaded (tests).
  const background = getComputedStyle(root).getPropertyValue('--background').trim();
  return background || (mode === 'dark' ? '0 0% 0%' : '220 14% 97%');
}
