import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Contact {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  email2: string | null;
  email3: string | null;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  company: string | null;
  job_title: string | null;
  notes: string | null;
  avatar_url: string | null;
  is_favorite: boolean;
}

export async function fetchAllContacts(signal?: AbortSignal): Promise<Contact[]> {
  const contacts: Contact[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (true) {
    const response = await api.get<{ contacts: Contact[]; has_more?: boolean }>(`/contacts?limit=2000&offset=${offset}`, { signal });
    if (response.error) throw new Error(response.error);
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

export type ContactInput = Pick<Contact, 'first_name'> & Partial<Omit<Contact, 'id' | 'is_favorite' | 'avatar_url'>>;

export interface MergePreviewGroup {
  key: string;
  size: number;
  keep: { id: string; name: string; email: string | null; phone: string | null };
  remove: Array<{ id: string; name: string; email: string | null; phone: string | null }>;
}

export interface MergePreview {
  groups: number;
  to_remove: number;
  merge_target_count: number;
  preview: MergePreviewGroup[];
}

export interface ImportResult { message: string; imported: number; total: number; errors?: string[] }

export const contactsQueryKeys = {
  all: ['contacts'] as const,
};

/** Everything that shows contacts reads from ['contacts']. */
export function invalidateContactQueries(client: QueryClient) {
  return client.invalidateQueries({ queryKey: contactsQueryKeys.all });
}

async function send<T>(request: Promise<{ data?: T; error?: string }>): Promise<T | undefined> {
  const response = await request;
  if (response.error) throw new Error(response.error);
  return response.data;
}

export const contactsApi = {
  create: (contact: ContactInput) => send(api.post('/contacts', contact)),
  update: (id: string, contact: Partial<ContactInput>) => send(api.put(`/contacts/${id}`, contact)),
  remove: (id: string) => send(api.delete(`/contacts/${id}`)),
  removeMany: async (ids: string[]) => (await send(api.post<{ deleted: number }>('/contacts/bulk-delete', { ids })))?.deleted ?? ids.length,
  setFavorite: (id: string, isFavorite: boolean) => send(api.put(`/contacts/${id}/favorite`, { is_favorite: isFavorite })),
  importVcf: async (vcf: string) => (await send(api.post<ImportResult>('/contacts/import', { vcf_data: vcf })))!,
  exportVcf: () => api.getBlob('/contacts/export'),
  previewMerge: async () => (await send(api.post<MergePreview>('/contacts/merge-duplicates/preview', {}))) ?? null,
  mergeDuplicates: async () => (await send(api.post<{ merged: number; removed: number; groups: number; message: string }>('/contacts/merge-duplicates', {}))) ?? null,
};

const clean = (value: string | null | undefined) => (value || '').trim();

export const contactEmails = (contact: Contact) => [contact.email, contact.email2, contact.email3].map(clean).filter(Boolean);
export const contactPhones = (contact: Contact) => [contact.phone, contact.phone2, contact.phone3].map(clean).filter(Boolean);

export function contactName(contact: Contact) {
  const name = [clean(contact.first_name), clean(contact.last_name)].filter(Boolean).join(' ');
  return name || contactEmails(contact)[0] || contactPhones(contact)[0] || 'No name';
}

export function contactInitials(contact: Contact) {
  const initials = (clean(contact.first_name)[0] || '') + (clean(contact.last_name)[0] || '');
  if (initials) return initials.toUpperCase();
  const email = contactEmails(contact)[0];
  if (email) return email[0].toUpperCase();
  return contactPhones(contact).length ? '#' : '?';
}

export const contactsQueryOptions = queryOptions({
  queryKey: contactsQueryKeys.all,
  queryFn: ({ signal }) => fetchAllContacts(signal),
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
