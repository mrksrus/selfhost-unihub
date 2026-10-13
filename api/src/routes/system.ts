import type { IncomingMessage } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';

import { db } from '../state';
import { healthCheck } from '../services/health';
import { getUserModules } from '../services/module-settings';

interface CountRow { count: number }

export = {
  'GET /health': () => healthCheck(),
  // Stats endpoint
  'GET /api/stats': async (req: IncomingMessage, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const enabled = new Map((await getUserModules(userId)).map(module => [module.id, module.enabled]));
      const query = (id: string, sql: string, params: string[]): Promise<[CountRow[], unknown?]> => enabled.get(id) ? db.execute<(CountRow & RowDataPacket)[]>(sql, params) : Promise.resolve([[{ count: 0 }]]);
      const [contacts] = await query('contacts',
        'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?',
        [userId]
      );
      const [events] = await query('calendar',
        `SELECT COUNT(*) as count
         FROM calendar_events
         WHERE user_id = ?
           AND start_time >= UTC_TIMESTAMP()
           AND is_todo_only = FALSE
           AND (todo_status IS NULL OR todo_status NOT IN ('done', 'cancelled'))`,
        [userId]
      );
      const [unread] = await query('mail',
        'SELECT COUNT(*) as count FROM emails WHERE user_id = ? AND is_read = FALSE',
        [userId]
      );

      return {
        contacts: contacts[0].count,
        upcomingEvents: events[0].count,
        unreadEmails: unread[0].count,
      };
    } catch (error) {
      return { error: 'Failed to get stats', status: 500 };
    }
  },
};
