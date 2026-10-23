import type { RouteRequest, ApiError } from '../types';
import type { MailThreadListResponse, MailThreadResponse } from '../contracts/mail-threads';
import { defineRoutes } from '../http/route';
import { clientError } from '../http/errors';
import { listMailThreads, mailThreadMessages } from '../services/mail-list';
import { log } from '../log';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// The conversation view of Mail (0.24). The message list (GET /api/mail/emails)
// keeps its shape; the app asks for conversations here when the person turned
// on mail_threaded_view. Reads only: a running restore does not lock them.
export = defineRoutes({
  'GET /api/mail/threads': { auth: 'user', module: 'mail', handler: async (req: Request, userId: string) => {
    try {
      const url = new URL(req.url, 'http://unihub.invalid');
      const { threads, pagination } = await listMailThreads(userId, url.searchParams);
      return { threads, pagination } satisfies MailThreadListResponse;
    } catch (error) {
      if (!(error as ApiError).status) log.error('mail', 'Listing conversations failed', error, { userId });
      return clientError(error, 'Failed to get conversations');
    }
  } },
  'GET /api/mail/emails/:id/thread': { auth: 'user', module: 'mail', handler: async (req: Request, userId: string) => {
    try {
      const { thread_key, messages, truncated } = await mailThreadMessages(userId, req.params.id);
      return { thread_key, messages, truncated } satisfies MailThreadResponse;
    } catch (error) {
      if (!(error as ApiError).status) log.error('mail', 'Loading a conversation failed', error, { userId });
      return clientError(error, 'Failed to get conversation');
    }
  } },
});
