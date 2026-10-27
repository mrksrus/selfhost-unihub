import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-provider test accounts for tests/providers, from the maintainer's private
// file (never committed): UNIHUB_E2E_PROVIDERS, or .private/e2e-providers.env of the
// canonical checkout (the main working tree when this is a Git worktree). A block
// whose values are empty is treated as missing. The values are registered as e2e
// secrets (e2e.config.ts), so run output shows <secret:…>; never log them yourself.
function canonicalCheckout() {
  const here = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim();
    return dirname(common);
  } catch {
    return here;
  }
}
export const providersFile = process.env.UNIHUB_E2E_PROVIDERS ?? join(canonicalCheckout(), '.private', 'e2e-providers.env');

export interface ProviderAccount {
  /** Secret-name prefix in e2e.config.ts, e.g. "stalwart-a". */
  key: string;
  email: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  caldavUrl: string;
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Account A (sender) and B (recipient) of the Stalwart blocks; null where a block is missing or incomplete. */
export function stalwartAccounts(path = providersFile): { a: ProviderAccount | null; b: ProviderAccount | null } {
  const env = readEnv(path);
  const block = (letter: 'A' | 'B'): ProviderAccount | null => {
    const v = (name: string) => env[`E2E_STALWART_${letter}_${name}`] ?? '';
    if (!v('EMAIL') || !v('PASSWORD') || !v('IMAP_HOST') || !v('SMTP_HOST')) return null;
    return {
      key: `stalwart-${letter.toLowerCase()}`,
      email: v('EMAIL'), username: v('USERNAME') || v('EMAIL'), password: v('PASSWORD'),
      imapHost: v('IMAP_HOST'), imapPort: Number(v('IMAP_PORT') || 993),
      smtpHost: v('SMTP_HOST'), smtpPort: Number(v('SMTP_PORT') || 465),
      caldavUrl: v('CALDAV_URL'),
    };
  };
  return { a: block('A'), b: block('B') };
}

/** Secrets for e2e.config.ts: every provider value long enough to register (6+ characters). */
export function providerSecrets(path = providersFile): Record<string, string> {
  const secrets: Record<string, string> = {};
  const { a, b } = stalwartAccounts(path);
  for (const account of [a, b]) {
    if (!account) continue;
    for (const field of ['email', 'username', 'password', 'imapHost', 'smtpHost', 'caldavUrl'] as const) {
      const value = account[field];
      const name = `${account.key}-${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      if (value.length >= 6 && !Object.values(secrets).includes(value)) secrets[name] = value;
    }
  }
  return secrets;
}

/** The registered secret name holding exactly this value, for filling it through secrets.get(). */
export function secretName(value: string) {
  const entry = Object.entries(providerSecrets()).find(([, registered]) => registered === value);
  if (!entry) throw new Error('that provider value is not registered as a secret');
  return entry[0];
}
