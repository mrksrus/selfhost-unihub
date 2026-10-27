import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The selected stack instance (UNIHUB_E2E_INSTANCE, default 1), as tools/e2e/stack.sh reports it.
const stackScript = fileURLToPath(new URL('../../stack.sh', import.meta.url));
const values = Object.fromEntries(
  execFileSync(stackScript, ['env'], { encoding: 'utf8' }).trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);

export const stack = {
  instance: Number(values.UNIHUB_E2E_INSTANCE),
  url: values.UNIHUB_E2E_URL,
  state: values.UNIHUB_E2E_STATE,
  providerHost: values.UNIHUB_E2E_PROVIDER_HOST,
  providerPassword: values.UNIHUB_E2E_PROVIDER_PASSWORD,
  smtpsPort: Number(values.UNIHUB_E2E_SMTPS_PORT),
  imapsPort: Number(values.UNIHUB_E2E_IMAPS_PORT),
  caldavUrl: values.UNIHUB_E2E_CALDAV_URL,
  greenmailApi: values.UNIHUB_E2E_GREENMAIL_API,
  caFile: values.UNIHUB_E2E_CA,
  dbPort: Number(values.UNIHUB_E2E_DB_PORT),
  dbEnvFile: values.UNIHUB_E2E_DB_ENV,
};

/** Restarts this instance's API (SIGTERM, as docker stop), for restart checks. */
export function restartApi() {
  return execFileSync(stackScript, ['restart-api'], { encoding: 'utf8' }).trim();
}

/** Libraries the API already depends on (nodemailer, mailparser, mysql2, imapflow), so the harness adds none. */
export const apiRequire = createRequire(fileURLToPath(new URL('../../../../api/package.json', import.meta.url)));

/** The synthetic people of tools/e2e/support/seed.mjs: UniHub sign-in and their provider mailbox. */
export const people = {
  admin: { email: 'admin@example.com', name: 'Avery Admin', mailbox: 'admin@mail.test' },
  alex: { email: 'alex@example.com', name: 'Alex Example', mailbox: 'alex@mail.test' },
  blair: { email: 'blair@example.com', name: 'Blair Third', mailbox: 'blair@mail.test' },
} as const;
export type Person = keyof typeof people;

/** Correspondents outside UniHub, with their own GreenMail mailboxes. */
export const outside = { sam: 'sam@example.org', carol: 'carol@example.org' } as const;

export const signInPassword = 'local-dev-admin-password';

/** A short id unique to this run, for names of the data a test creates. */
export const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Committed synthetic fixtures (paths relative to tools/e2e, as setInputFiles expects). */
export const fixtures = {
  pdf: { path: 'fixtures/synthetic-report.pdf', name: 'synthetic-report.pdf', size: 663, text: 'UniHub synthetic test PDF' },
  jpg: { path: 'fixtures/synthetic-photo.jpg', name: 'synthetic-photo.jpg', size: 907 },
};
export const fixturePath = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
