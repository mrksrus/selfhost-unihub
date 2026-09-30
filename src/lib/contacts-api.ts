import { queryOptions } from '@tanstack/react-query';
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

export const contactsQueryOptions = queryOptions({
  queryKey: ['contacts'],
  queryFn: ({ signal }) => fetchAllContacts(signal),
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
