/**
 * The accent colour: buttons, links, the selected page, the UniHub mark. One
 * hue per choice, with a lighter variant for the dark theme where the default
 * stylesheet also uses a lighter ring and calendar fallback. Everything else
 * in the palette (warning, destructive, success) stays as it is, so an accent
 * never collides with a colour that carries meaning.
 */
export type AccentId = 'blue' | 'indigo' | 'violet' | 'pink' | 'teal' | 'green';

export interface Accent {
  id: AccentId;
  label: string;
  /** Light theme: primary, accent and ring. HSL channels as in index.css. */
  light: string;
  /** Dark theme: primary and accent. */
  dark: string;
  /** Dark theme: ring and the calendar fallback colour, lighter than the accent. */
  darkRing: string;
}

export const ACCENTS: readonly Accent[] = [
  { id: 'blue', label: 'Blue', light: '221 83% 53%', dark: '221 83% 53%', darkRing: '213 94% 68%' },
  { id: 'indigo', label: 'Indigo', light: '243 75% 59%', dark: '239 84% 62%', darkRing: '234 89% 74%' },
  { id: 'violet', label: 'Violet', light: '262 83% 58%', dark: '258 90% 62%', darkRing: '255 92% 76%' },
  { id: 'pink', label: 'Pink', light: '333 71% 51%', dark: '330 75% 50%', darkRing: '329 86% 70%' },
  { id: 'teal', label: 'Teal', light: '175 84% 28%', dark: '172 66% 50%', darkRing: '171 77% 64%' },
  { id: 'green', label: 'Green', light: '142 72% 29%', dark: '142 71% 45%', darkRing: '142 69% 58%' },
];

export const DEFAULT_ACCENT: AccentId = 'blue';
const STORAGE_KEY = 'unihub:accent';

export const isAccentId = (value: unknown): value is AccentId => ACCENTS.some(accent => accent.id === value);
export const accentById = (id: AccentId) => ACCENTS.find(accent => accent.id === id) ?? ACCENTS[0];

/** The accent last applied on this device, so a reload does not flash blue first. */
export function readStoredAccent(): AccentId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isAccentId(stored) ? stored : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function storeAccent(id: AccentId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* Storage may be disabled. */ }
}

/** '221 83% 53%' to 0-255 sRGB channels. */
function hslChannelsToRgb(channels: string) {
  const [h, s, l] = channels.split(/\s+/).map(part => Number.parseFloat(part));
  const sat = s / 100, light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [r, g, b].map(channel => Math.round((channel + m) * 255));
}

/** '221 83% 53%' to '#2563eb', for places that need a plain colour (theme-color, the icon). */
export function hslChannelsToHex(channels: string) {
  return '#' + hslChannelsToRgb(channels).map(channel => channel.toString(16).padStart(2, '0')).join('');
}

/** WCAG 2 contrast ratio between two colours given as HSL channels. */
export function contrastRatio(a: string, b: string) {
  const luminance = (channels: string) => {
    const [r, g, b] = hslChannelsToRgb(channels).map(value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const WHITE = '0 0% 100%';
const BLACK = '0 0% 0%';

/** Text and icons on the accent: white as in the stylesheet, black where white would not be legible (WCAG AA). */
export function accentForeground(id: AccentId, dark: boolean) {
  const accent = accentById(id);
  return contrastRatio(dark ? accent.dark : accent.light, WHITE) >= 4.5 ? WHITE : BLACK;
}

/** The UniHub mark with the accent, as the page icon. */
export function accentIconUrl(id: AccentId) {
  if (id === DEFAULT_ACCENT) return '/favicon.svg';
  const hex = hslChannelsToHex(accentById(id).light);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#000000"/><stop offset="100%" stop-color="${hex}"/></linearGradient></defs><rect width="100" height="100" rx="20" fill="url(#g)"/><text x="50" y="65" font-family="system-ui, sans-serif" font-size="50" font-weight="bold" fill="white" text-anchor="middle">U</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Writes the accent into the page: the colour variables the stylesheet
 * defines for the theme in force, the page icon, and the browser's
 * theme-color (the accent on light, black on dark, as before).
 */
export function applyAccent(id: AccentId, dark: boolean) {
  const accent = accentById(id);
  const root = document.documentElement.style;
  if (id === DEFAULT_ACCENT) {
    for (const name of ['--primary', '--primary-foreground', '--accent', '--accent-foreground', '--ring', '--calendar-color']) root.removeProperty(name);
  } else {
    const foreground = accentForeground(id, dark);
    root.setProperty('--primary', dark ? accent.dark : accent.light);
    root.setProperty('--primary-foreground', foreground);
    root.setProperty('--accent', dark ? accent.dark : accent.light);
    root.setProperty('--accent-foreground', foreground);
    root.setProperty('--ring', dark ? accent.darkRing : accent.light);
    root.setProperty('--calendar-color', dark ? accent.darkRing : accent.light);
  }
  document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.setAttribute('href', accentIconUrl(id));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : hslChannelsToHex(accent.light));
}
