import type { MailFolder } from '@/lib/mail-api';
import type { NotificationFolderRef } from '@/lib/settings-api';

// The folder references of a mail account's notification filter
// (notify_folders): a system folder by its role, so the default covers every
// account's own Junk folder, another folder by its id.

const UUID = /^[0-9a-f-]{36}$/;

/** The filter's reference for a folder, or null for a folder it cannot name (a legacy folder). */
export function folderRef(folder: Pick<MailFolder, 'id' | 'roles'>): NotificationFolderRef | null {
  if (folder.roles?.length) return `role:${folder.roles[0]}`;
  return UUID.test(folder.id) ? `folder:${folder.id}` : null;
}

/** Whether a reference names this folder, by one of its roles or by its id. */
export const refersTo = (ref: string, folder: Pick<MailFolder, 'id' | 'roles'>) =>
  ref.startsWith('role:') ? (folder.roles ?? []).includes(ref.slice(5)) : ref === `folder:${folder.id}`;

/** The list with this folder in or out of it; references to other folders (also ones the account has no folder for) stay. */
export function toggleFolder(refs: NotificationFolderRef[], folder: Pick<MailFolder, 'id' | 'roles'>, on: boolean): NotificationFolderRef[] {
  const rest = refs.filter(ref => !refersTo(ref, folder));
  const ref = folderRef(folder);
  return on && ref ? [...rest, ref] : rest;
}
