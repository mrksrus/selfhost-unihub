const { db } = require('../state');

function escapeLike(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString() : (value || null);
}

module.exports = {
  'GET /api/search': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const q = (url.searchParams.get('q') || '').trim();
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '8', 10);
      const perTypeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 8;

      if (q.length < 2) {
        return { query: q, results: [] };
      }

      const like = `%${escapeLike(q)}%`;
      const [contacts] = await db.execute(
        `SELECT id, first_name, last_name, email, email2, email3, company
         FROM contacts
         WHERE user_id = ?
           AND (
             first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR email2 LIKE ? OR email3 LIKE ? OR
             phone LIKE ? OR phone2 LIKE ? OR phone3 LIKE ? OR company LIKE ?
           )
         ORDER BY is_favorite DESC, first_name ASC, last_name ASC
         LIMIT ${perTypeLimit}`,
        [userId, like, like, like, like, like, like, like, like, like]
      );

      const [emails] = await db.execute(
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

      const [events] = await db.execute(
        `SELECT id, title, description, start_time, is_todo_only, todo_status
         FROM calendar_events
         WHERE user_id = ?
           AND (title LIKE ? OR description LIKE ? OR location LIKE ?)
         ORDER BY start_time ASC
         LIMIT ${perTypeLimit}`,
        [userId, like, like, like]
      );

      const results = [
        ...contacts.map((contact) => {
          const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || 'Contact';
          return {
            id: `contact:${contact.id}`,
            type: 'contact',
            title: name,
            subtitle: contact.email || contact.email2 || contact.email3 || contact.company || '',
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
      ];

      return { query: q, results };
    } catch (error) {
      console.error('Global search error:', error);
      return { error: 'Failed to search', status: 500 };
    }
  },
};
