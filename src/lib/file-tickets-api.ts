import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { FileTicketRequest, FileTicketResponse } from '../../api/src/contracts/files';
export type { FileTicketKind, FileTicketResponse } from '../../api/src/contracts/files';

/**
 * A download ticket for one of the user's files (F9, api/src/routes/files.ts):
 * its URL fetches the file once, within a minute, without the session. For
 * the Android app's file actions (lib/platform.ts), never for the page itself.
 */
export async function createFileTicket(request: FileTicketRequest): Promise<FileTicketResponse> {
  const ticket = unwrap(await api.post<FileTicketResponse>('/files/tickets', request));
  if (!ticket) throw new Error('Could not prepare the download');
  return ticket;
}
