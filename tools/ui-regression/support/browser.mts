// Browser and font conditions shared by global setup and the Playwright config.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { browsersDir, buildDir, toolRoot } from './env.mts';

export const fontsDir = path.join(buildDir, 'fonts');
export const fontconfigFile = path.join(buildDir, 'fonts.conf');

// Use the browser pinned by this package's lockfile, downloaded into
// tools/ui-regression/.browsers, never a browser found elsewhere on the machine.
// Playwright reads the variable when it loads, so scripts/run.mts sets it
// before starting the runner.
export function requirePinnedBrowserPath() {
  if (path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '') !== browsersDir) {
    throw new Error(`Start the UI checks with npm run verify (or update) in tools/ui-regression, or set PLAYWRIGHT_BROWSERS_PATH=${browsersDir}.`);
  }
}

export const launchOptions = {
  args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-gpu', '--disable-skia-runtime-opts', '--num-raster-threads=1', '--disable-partial-raster'],
  // Fallback fonts come from the pinned packages only, so a glyph the web fonts
  // lack renders the same on every machine instead of with a local system font.
  env: { ...process.env, FONTCONFIG_FILE: fontconfigFile },
};

/** WOFF 1.0 to a plain sfnt: Chromium's fallback font loader reads TrueType files, not WOFF. */
function woffToSfnt(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('Not a WOFF 1.0 font');
  const numTables = woff.readUInt16BE(12);
  const tables = Array.from({ length: numTables }, (_, index) => {
    const entry = 44 + index * 20;
    const offset = woff.readUInt32BE(entry + 4);
    const compLength = woff.readUInt32BE(entry + 8);
    const origLength = woff.readUInt32BE(entry + 12);
    const raw = woff.subarray(offset, offset + compLength);
    return { tag: woff.subarray(entry, entry + 4), checksum: woff.readUInt32BE(entry + 16), data: compLength < origLength ? zlib.inflateSync(raw) : raw };
  });
  const entrySelector = Math.floor(Math.log2(numTables));
  const header = Buffer.alloc(12 + numTables * 16);
  woff.copy(header, 0, 4, 8);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(2 ** entrySelector * 16, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - 2 ** entrySelector * 16, 10);
  const parts: Buffer[] = [header];
  let offset = header.length;
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    table.tag.copy(header, record);
    header.writeUInt32BE(table.checksum, record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(table.data.length, record + 12);
    const padded = Buffer.alloc((table.data.length + 3) & ~3);
    table.data.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}

/** Writes the pinned fonts as TrueType files and a fontconfig that knows nothing else. */
export function prepareFonts() {
  fs.rmSync(fontsDir, { recursive: true, force: true });
  fs.mkdirSync(fontsDir, { recursive: true });
  const files = [
    ...[300, 400, 500, 600, 700].map(weight => ['inter', `inter-latin-${weight}-normal`]),
    ...[400, 500].map(weight => ['jetbrains-mono', `jetbrains-mono-latin-${weight}-normal`]),
  ];
  for (const [family, file] of files) {
    const woff = fs.readFileSync(path.join(toolRoot, 'node_modules/@fontsource', family, 'files', `${file}.woff`));
    fs.writeFileSync(path.join(fontsDir, `${file}.ttf`), woffToSfnt(woff));
  }
  const alias = (generic: string, family: string) => `  <alias binding="strong"><family>${generic}</family><prefer><family>${family}</family></prefer></alias>`;
  fs.writeFileSync(fontconfigFile, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    `  <dir>${fontsDir}</dir>`,
    `  <cachedir>${path.join(buildDir, 'fontconfig-cache')}</cachedir>`,
    ...['sans-serif', 'serif', 'system-ui', 'ui-sans-serif'].map(generic => alias(generic, 'Inter')),
    ...['monospace', 'ui-monospace'].map(generic => alias(generic, 'JetBrains Mono')),
    '</fontconfig>',
    '',
  ].join('\n'));
}
