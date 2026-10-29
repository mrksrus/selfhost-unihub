import type { RouteRequest } from '../types';
import type { RowDataPacket } from 'mysql2/promise';
import { db } from '../state';
import { getUserModules } from '../services/module-settings';
import { escapeLike } from '../services/sql';
import { defineRoutes } from '../http/route';
import { contactSearchCondition, displayName } from '../services/contacts';

function isoDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : (value || null);
}

export = defineRoutes({
  'GET /api/search': { auth: 'user', module: null, handler: async (req: RouteRequest, userId: string) => {

    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const q = (url.searchParams.get('q') || '').trim();
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '8', 10);
      const perTypeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 8;

      if (q.length < 2) {
        return { query: q, results: [] };
      }

      const modules = new Map((await getUserModules(userId)).map(module => [module.id, module.enabled]));
      const queryModule = (id: string, sql: string, params: string[]): Promise<[RowDataPacket[], unknown?]> => modules.get(id) ? db.execute<RowDataPacket[]>(sql, params) : Promise.resolve([[]]);
      const like = `%${escapeLike(q)}%`;
      const contactSearch = contactSearchCondition(q);
      const [contacts] = await queryModule('contacts',
        `SELECT c.id, c.first_name, c.middle_name, c.last_name, c.display_name, c.company,
           (SELECT v.value FROM contact_values v WHERE v.contact_id = c.id AND v.kind = 'email' ORDER BY v.position LIMIT 1) AS email,
           (SELECT v.value FROM contact_values v WHERE v.contact_id = c.id AND v.kind = 'phone' ORDER BY v.position LIMIT 1) AS phone
         FROM contacts c
         WHERE c.user_id = ? AND ${contactSearch.sql}
         ORDER BY c.is_favorite DESC, c.first_name ASC, c.last_name ASC
         LIMIT ${perTypeLimit}`,
        [userId, ...contactSearch.params]
      );

      const [emails] = await queryModule('mail',
        `SELECT id, subject, from_address, from_name, folder, received_at
         FROM emails
         WHERE user_id = ?
           AND (
             subject LIKE ? OR from_name LIKE ? OR from_address LIKE ? OR body_text LIKE ?
           )
         ORDER BY received_at DESC
         LIMIT ${perTypeLimit}`,
        [userId, like, like, like, like]
      );

      const [events] = await queryModule('calendar',
        `SELECT id, title, description, start_time, is_todo_only, todo_status
         FROM calendar_events
         WHERE user_id = ?
           AND (title LIKE ? OR description LIKE ? OR location LIKE ?)
         ORDER BY start_time ASC
         LIMIT ${perTypeLimit}`,
        [userId, like, like, like]
      );

      const [recordings] = await queryModule('recordings',
        `SELECT id, title, description, recorded_at, created_at
         FROM recordings
         WHERE user_id = ?
           AND (
             title LIKE ?
             OR description LIKE ?
             OR original_filename LIKE ?
             OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.chords')), '') LIKE ?
           )
         ORDER BY recorded_at DESC, created_at DESC
         LIMIT ${perTypeLimit}`,
        [userId, like, like, like, like]
      );

      const results = [
        ...contacts.map((contact) => {
          const values = [{ kind: 'email', value: contact.email || '' }, { kind: 'phone', value: contact.phone || '' }].filter(value => value.value);
          return {
            id: `contact:${contact.id}`,
            type: 'contact',
            title: displayName(contact as Parameters<typeof displayName>[0], values) || 'Contact',
            subtitle: contact.email || contact.company || contact.phone || '',
            href: `/contacts?search=${encodeURIComponent(q)}`,
            entity_id: contact.id,
          };
        }),
        ...emails.map((email) => ({
          id: `email:${email.id}`,
          type: 'mail',
          title: email.subject || '(No subject)',
          subtitle: `${email.from_name || email.from_address} • ${email.folder}`,
          href: `/mail?email=${encodeURIComponent(email.id)}`,
          entity_id: email.id,
          date: isoDate(email.received_at),
        })),
        ...events.map((event) => ({
          id: `calendar:${event.id}`,
          type: event.is_todo_only ? 'todo' : 'calendar',
          title: event.title,
          subtitle: event.is_todo_only ? 'ToDo' : isoDate(event.start_time),
          href: event.is_todo_only ? '/todo' : '/calendar',
          entity_id: event.id,
          date: isoDate(event.start_time),
          status: event.todo_status || null,
        })),
        ...recordings.map((recording) => ({
          id: `recording:${recording.id}`,
          type: 'recording',
          title: recording.title,
          subtitle: recording.description || isoDate(recording.recorded_at || recording.created_at) || 'Recording',
          href: `/recordings?search=${encodeURIComponent(q)}`,
          entity_id: recording.id,
          date: isoDate(recording.recorded_at || recording.created_at),
        })),
      ];

      return { query: q, results };
    } catch (error) {
      console.error('Global search error:', error);
      return { error: 'Failed to search', status: 500 };
    }
  } },
});
