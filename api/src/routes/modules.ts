import type { IncomingMessage } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';
import type { ApiError, StoredFlag } from '../types';

interface ModuleRequest { modules?: { mail?: unknown }; [key: string]: unknown }

const imported1: typeof import('../services/module-settings') = require('../services/module-settings');
const { getOrderedUserModules, getUserPages, setUserModules } = imported1;
export = {
  'GET /api/modules': async (_req: IncomingMessage, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    return { modules: await getOrderedUserModules(userId), pages: await getUserPages(userId) };
  },
  'PUT /api/modules': async (_req: IncomingMessage, userId: string | null, body: ModuleRequest) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const modules = await setUserModules(userId, body);
      (require('../services/server-events') as typeof import('../services/server-events')).serverEvents.setUserModules(userId,
        modules.filter(module => module.enabled).map(module => module.id));
      if (body.modules?.mail) {
        const { db }: typeof import('../state') = require('../state');
        const imported2: typeof import('../services/mail') = require('../services/mail');
const { stopMailAccountWork, cancelMailAccountSync } = imported2;
        const imported3: typeof import('../services/mail-engine/rollout') = require('../services/mail-engine/rollout');
const { USER_PAUSES } = imported3;
        const mail = modules.find(module => module.id === 'mail')!;
        const [accounts] = await db.execute<(RowDataPacket & { id: string; is_active: StoredFlag; disconnected_at: Date | null })[]>('SELECT id, is_active, disconnected_at FROM mail_accounts WHERE user_id = ?', [userId]);
        if (!mail.enabled) {
          for (const account of accounts) await stopMailAccountWork(account.id, 'Mail module disabled');
        } else {
          // Background off is a scheduling preference enforced at admission,
          // not an account fence: user Sync/flag/move work must keep running
          // without clearing it. Only queued/running background read work is
          // dropped; a requested Sync, such as a restored account's first
          // download, resumes.
          for (const account of accounts) {
            if (Number(account.is_active) && !account.disconnected_at)
              await (require('../services/mail-engine/runtime') as typeof import('../services/mail-engine/runtime')).resumeAccount({ userId, accountId: account.id,
                resumeStreams: mail.background, reasons: USER_PAUSES });
            if (!mail.background) await cancelMailAccountSync(account.id, { keepManual: true });
          }
          // The IDLE session is background work: close it now, or start it
          // without waiting for the supervisor's next eligibility pass.
          const imported4: typeof import('../services/mail-idle') = require('../services/mail-idle');
const { idleSupervisor } = imported4;
          if (!mail.background) for (const account of accounts) idleSupervisor.stopAccount(account.id);
          else void idleSupervisor.refresh();
        }
      }
      return { modules, pages: await getUserPages(userId) };
    }
    catch (error) { if ((error as ApiError).status === 400) return { error: (error as ApiError).message, status: 400 }; throw error; }
  },
};
