import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fixturePath, fixtures, stack } from './env.ts';
import { ok, pageApi } from './api.ts';

// Contacts in the shape of api/src/contracts/contacts.ts, as far as the tests read them.
export interface Labelled { id: string; value: string; label: string; custom_label: string | null; preferred: boolean }
export interface ContactRecord {
  id: string; uid: string; version: number; display_name: string;
  name: { display: string | null; given: string | null; family: string | null; middle: string | null; prefix: string | null; suffix: string | null };
  organization: { name: string | null; department: string | null }; job_title: string | null;
  birthday: { year?: number | null; month: number; day: number } | null;
  emails: Labelled[]; phones: Labelled[]; addresses: (Labelled & { street: string | null; locality: string | null; country: string | null })[];
  categories: string[]; nicknames: Labelled[]; notes: string | null; is_favorite: boolean;
  photo: { etag: string } | null; kept_properties: number;
  // The 3+3 projection the old Android apps read (P-21).
  email: string | null; email2: string | null; email3: string | null; phone: string | null; phone2: string | null; phone3: string | null; company: string | null;
}

/** Six digits unique to this run, so a number never matches an earlier run's contact. */
export const runDigits = () => String(Date.now()).slice(-6);

/**
 * A fixture of tools/e2e/fixtures/contacts with the run's names and numbers:
 * RUN becomes `run`, NUMn becomes the run's digits followed by n, PHOTOB64 the
 * synthetic JPEG. The bytes stay as they are otherwise (one file is
 * ISO-8859-1), so the server's character set detection is what is tested.
 */
export function contactFixture(file: string, run: string, digits: string) {
  const bytes = readFileSync(fixturePath(`fixtures/contacts/${file}`));
  const text = bytes.toString('latin1')
    .replaceAll('PHOTOB64', readFileSync(fixturePath(fixtures.jpg.path)).toString('base64'))
    .replace(/NUM(\d)/g, (_, n: string) => `${digits}${n}`)
    .replaceAll('RUN', run);
  return writeUpload(file, Buffer.from(text, 'latin1'));
}

/** Writes a file to hand to a file input under the instance's state directory (the e2e setInputFiles takes paths). */
export function writeUpload(name: string, content: Buffer | string) {
  const folder = `${stack.state}/e2e-uploads`;
  mkdirSync(folder, { recursive: true });
  const path = `${folder}/${Date.now()}-${name}`;
  writeFileSync(path, content);
  return path;
}

type Page = { locator: (css: string) => { setInputFiles: (files: string[]) => Promise<void> }; evaluate: <R>(fn: () => R) => Promise<R> };

/** Hands a file to the open dialog's hidden file input (the import's "Choose file"). */
export async function chooseFile(browser: unknown, path: string) {
  await (browser as Page).locator('[role=dialog] input[type=file]').setInputFiles([path]);
}

export async function listContacts(browser: unknown) {
  return ok(await pageApi<{ contacts: ContactRecord[] }>(browser, 'GET', '/api/contacts?limit=2000'), 'list contacts').contacts;
}

export async function createContact(browser: unknown, body: Record<string, unknown>) {
  return ok(await pageApi<{ contact: ContactRecord }>(browser, 'POST', '/api/contacts', body), 'create contact').contact;
}

export async function getContact(browser: unknown, id: string) {
  return ok(await pageApi<{ contact: ContactRecord & { properties: { name: string; value: string }[] } }>(browser, 'GET', `/api/contacts/${id}`), 'get contact').contact;
}

/**
 * Records what the page saves through a download link (saveFile in a
 * browser): the file name and the blob's text. Call before the action;
 * `savedFile` waits for it.
 */
export async function recordSavedFiles(browser: unknown) {
  await (browser as Page).evaluate(() => {
    const record = window as unknown as { blobs: Map<string, Blob>; saved: { name: string; text: string }[] };
    record.blobs = new Map();
    record.saved = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      if (object instanceof Blob) record.blobs.set(url, object);
      return url;
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      const blob = record.blobs.get(this.href);
      const name = this.download;
      if (blob) void blob.text().then(text => record.saved.push({ name, text }));
    };
  });
}

export async function savedFiles(browser: unknown) {
  return (browser as Page).evaluate(() => (window as unknown as { saved?: { name: string; text: string }[] }).saved ?? []);
}
