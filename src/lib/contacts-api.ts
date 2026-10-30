// The browser's side of the contacts API (F11): the routes of docs/CONTACTS.md
// with the shapes of api/src/contracts/contacts.ts, and the query keys every
// contacts view shares. Views and hooks go through this module, never the raw
// client.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import type {
  AutoMergeRequest, AutoMergeResult, BulkContactUpdate, ContactDetail, ContactInput, ContactListResponse, ContactRecord, ContactResponse,
  ContactSingleField, ContactValueKind, DismissDuplicatesRequest, DuplicateConfidence, DuplicatesResponse, ExportFormat, ImportCommitRequest, ImportStatus,
  ImportSummary, MergeRecord, MergeRequest, MergeResult, UndoMergeResult,
} from '../../api/src/contracts/contacts';

export type {
  Address, AddressInput, AutoMergeResult, ContactDetail, ImportCardSummary, ContactInput, ContactName, ContactPhoto, ContactRecord, ContactSingleField,
  DuplicateConfidence, DuplicateGroup, DuplicateMember, DuplicateReason, ExportFormat, ImportDecisionKind, ImportGroup, ImportStatus, ImportSummary,
  ImportWarning, KeptProperty, LabelledValue, LabelledValueInput, MergeRecord, MergeRequest, MergeResult, PartialDate, UndoMergeResult,
} from '../../api/src/contracts/contacts';

/** The page works on the API's record: the model plus the deprecated 3+3 projection that old apps read. */
export type Contact = ContactRecord;

export async function fetchAllContacts(signal?: AbortSignal): Promise<Contact[]> {
  const contacts: Contact[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (true) {
    const response = await api.get<ContactListResponse>(`/contacts?limit=2000&offset=${offset}`, { signal });
    if (response.error) throw new ApiError(response);
    if (!Array.isArray(response.data?.contacts)) throw new Error('Invalid contacts response');
    const page = response.data.contacts;
    for (const contact of page) {
      if (!seen.has(contact.id)) { seen.add(contact.id); contacts.push(contact); }
    }
    if (!response.data.has_more) return contacts;
    if (!page.length) throw new Error('Contacts pagination did not advance. Please refresh.');
    offset += page.length;
  }
}

/** The fields that can be set on many contacts at once; null clears a field. */
export type BulkContactChange = BulkContactUpdate['contact'];

/** A stale full update: the server answered with the contact as it is now. */
export class ContactVersionConflict extends ApiError {
  readonly current: Contact;
  constructor(response: { error?: string; status?: number; contact: Contact }) {
    super(response);
    this.name = 'ContactVersionConflict';
    this.current = response.contact;
  }
}

export const contactsQueryKeys = {
  all: ['contacts'] as const,
  detail: (id: string) => ['contacts', 'detail', id] as const,
  duplicates: (min: DuplicateConfidence) => ['contacts', 'duplicates', min] as const,
  merges: ['contacts', 'merges'] as const,
  importStatus: (id: string) => ['contacts', 'imports', id] as const,
};

/** Everything that shows contacts reads from ['contacts']. */
export function invalidateContactQueries(client: QueryClient) {
  return client.invalidateQueries({ queryKey: contactsQueryKeys.all });
}

/**
 * A merge the server refused with something to act on: the members changed
 * (VERSION_CONFLICT, `contacts` as they are now), a field still needs a
 * choice (CHOICE_REQUIRED, `conflicts`), or the merged contact would hold
 * too many values (TOO_MANY_VALUES, `kinds`).
 */
export class MergeRefused extends ApiError {
  readonly contacts: Contact[];
  readonly conflicts: ContactSingleField[];
  readonly kinds: ContactValueKind[];
  constructor(response: { error?: string; status?: number; code?: unknown; contacts?: unknown; conflicts?: unknown; details?: unknown }) {
    super(response as { error?: string; status?: number; [key: string]: unknown });
    this.name = 'MergeRefused';
    this.contacts = Array.isArray(response.contacts) ? response.contacts as Contact[] : [];
    this.conflicts = Array.isArray(response.conflicts) ? response.conflicts as ContactSingleField[] : [];
    const details = response.details as { kinds?: unknown } | undefined;
    this.kinds = Array.isArray(details?.kinds) ? details.kinds as ContactValueKind[] : [];
  }
}

const MERGE_REFUSALS = new Set(['VERSION_CONFLICT', 'CHOICE_REQUIRED', 'TOO_MANY_VALUES']);

/** The largest picture the server takes (services/contact-photos.ts MAX_INPUT_BYTES); a larger one is refused before it is sent. */
export const CONTACT_PHOTO_MAX_BYTES = 20 * 1024 * 1024;

const required = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server sent no ${what}.`);
  return value;
};

async function setPhoto(id: string, file: Blob) {
  if (file.size > CONTACT_PHOTO_MAX_BYTES) throw new ApiError({ error: `This picture is larger than ${CONTACT_PHOTO_MAX_BYTES / 1024 / 1024} MB.`, status: 413, code: 'PHOTO_TOO_LARGE' });
  const response = await api.uploadBlob<ContactResponse>(`/contacts/${encodeURIComponent(id)}/photo`, file, file.type || 'application/octet-stream', 'PUT');
  // The request boundary's own size refusal carries no code.
  if (response.error && response.status === 413 && !response.code) throw new ApiError({ ...response, error: `This picture is larger than ${CONTACT_PHOTO_MAX_BYTES / 1024 / 1024} MB.`, code: 'PHOTO_TOO_LARGE' });
  return required(unwrap(response)?.contact, 'contact');
}

async function sendContact(request: Promise<{ data?: ContactResponse; error?: string; status?: number; [key: string]: unknown }>) {
  const response = await request;
  if (response.error && response.code === 'VERSION_CONFLICT' && response.contact) {
    throw new ContactVersionConflict({ error: response.error, status: response.status, contact: response.contact as Contact });
  }
  return required(unwrap(response)?.contact, 'contact');
}

/** The browser's photo URL for a contact; the etag makes a changed picture a new address. */
export function contactPhotoUrl(contact: Pick<Contact, 'id' | 'photo'>, size: 'full' | 'thumb') {
  if (!contact.photo) return null;
  return api.getDownloadUrl(`/contacts/${encodeURIComponent(contact.id)}/photo?size=${size}&v=${encodeURIComponent(contact.photo.etag)}`);
}

export const contactsApi = {
  get: async (id: string) => required(unwrap(await api.get<{ contact: ContactDetail }>(`/contacts/${encodeURIComponent(id)}`))?.contact, 'contact'),
  create: (contact: ContactInput) => sendContact(api.post<ContactResponse>('/contacts', contact)),
  update: (id: string, contact: ContactInput) => sendContact(api.put<ContactResponse>(`/contacts/${encodeURIComponent(id)}`, contact)),
  remove: async (id: string) => { unwrap(await api.delete(`/contacts/${encodeURIComponent(id)}`)); },
  removeMany: async (ids: string[]) => unwrap(await api.post<{ deleted: number }>('/contacts/bulk-delete', { ids }))?.deleted ?? ids.length,
  updateMany: async (ids: string[], contact: BulkContactChange) => unwrap(await api.post<{ updated: number }>('/contacts/bulk-update', { ids, contact }))?.updated ?? ids.length,
  setFavorite: async (id: string, isFavorite: boolean) => { unwrap(await api.put(`/contacts/${encodeURIComponent(id)}/favorite`, { is_favorite: isFavorite })); },

  // Photos (slice 4): the server converts the picture; the page never crops.
  setPhoto,
  removePhoto: async (id: string) => required(unwrap(await api.delete<ContactResponse>(`/contacts/${encodeURIComponent(id)}/photo`))?.contact, 'contact'),

  // Duplicates and merges (slices 5 and 6).
  duplicates: async (min: DuplicateConfidence, signal?: AbortSignal) => required(unwrap(await api.get<DuplicatesResponse>(`/contacts/duplicates?min=${min}`, { signal })), 'duplicate groups'),
  dismissDuplicates: async (contactIds: string[]) => { unwrap(await api.post('/contacts/duplicates/dismiss', { contact_ids: contactIds } satisfies DismissDuplicatesRequest)); },
  merge: async (request: MergeRequest) => {
    const response = await api.post<MergeResult>('/contacts/merges', request);
    if (response.error && typeof response.code === 'string' && MERGE_REFUSALS.has(response.code)) throw new MergeRefused(response);
    return required(unwrap(response), 'merge result');
  },
  mergeAll: async (groupIds: string[]) => required(unwrap(await api.post<AutoMergeResult>('/contacts/merges/auto', { group_ids: groupIds, min: 'high' } satisfies AutoMergeRequest)), 'merge results'),
  merges: async (signal?: AbortSignal) => required(unwrap(await api.get<{ merges: MergeRecord[] }>('/contacts/merges', { signal })), 'merges').merges ?? [],
  undoMerge: async (mergeId: string) => required(unwrap(await api.post<UndoMergeResult>(`/contacts/merges/${encodeURIComponent(mergeId)}/undo`, {})), 'undo result'),

  // Import with preview (slice 3): the file is staged, nothing is written before the commit.
  stageImport: async (file: File) => required(unwrap(await api.uploadBlob<ImportSummary>('/contacts/imports', file, file.type || 'application/octet-stream')), 'import summary'),
  commitImport: async (id: string, decisions: ImportCommitRequest['decisions']) => required(unwrap(await api.post<ImportStatus>(`/contacts/imports/${encodeURIComponent(id)}/commit`, { decisions } satisfies ImportCommitRequest)), 'import status'),
  importStatus: async (id: string, signal?: AbortSignal) => required(unwrap(await api.get<ImportStatus>(`/contacts/imports/${encodeURIComponent(id)}`, { signal })), 'import status'),

  // Export: every contact, or the selection.
  exportAll: (format: ExportFormat) => api.getBlob(`/contacts/export?format=${format}`),
  exportSelected: (ids: string[], format: ExportFormat) => api.postBlob('/contacts/export', { ids, format }),
};

export const contactsQueryOptions = queryOptions({
  queryKey: contactsQueryKeys.all,
  queryFn: ({ signal }) => fetchAllContacts(signal),
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export const contactDetailQueryOptions = (id: string) => queryOptions({
  queryKey: contactsQueryKeys.detail(id),
  queryFn: () => contactsApi.get(id),
  staleTime: 60 * 1000,
});

export const duplicatesQueryOptions = (min: DuplicateConfidence) => queryOptions({
  queryKey: contactsQueryKeys.duplicates(min),
  queryFn: ({ signal }) => contactsApi.duplicates(min, signal),
  staleTime: 60 * 1000,
  refetchOnWindowFocus: false,
});

export const mergesQueryOptions = queryOptions({
  queryKey: contactsQueryKeys.merges,
  queryFn: ({ signal }) => contactsApi.merges(signal),
  staleTime: 60 * 1000,
  refetchOnWindowFocus: false,
});

// Kept for the composer and the offline search, which read the lists.
export const contactEmails = (contact: Pick<Contact, 'emails'>) => contact.emails.map(entry => entry.value.trim()).filter(Boolean);
export const contactPhones = (contact: Pick<Contact, 'phones'>) => contact.phones.map(entry => entry.value.trim()).filter(Boolean);
export { contactName, contactInitials } from '@/lib/contact-fields';
