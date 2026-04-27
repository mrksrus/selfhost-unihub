const { db, getDb } = require('../state');


module.exports = {
  'GET /health': async () => {
    try {
      if (!getDb()) {
        return { status: 503, health: 'error', database: 'not_initialized', timestamp: new Date().toISOString() };
      }
      await db.execute('SELECT 1');
      return { health: 'ok', database: 'ok', timestamp: new Date().toISOString() };
    } catch (error) {
      return { status: 503, health: 'error', database: 'unavailable', error: error.message, timestamp: new Date().toISOString() };
    }
  },
  // Stats endpoint
  'GET /api/stats': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?',
        [userId]
      );
      const [events] = await db.execute(
        `SELECT COUNT(*) as count
         FROM calendar_events
         WHERE user_id = ?
           AND start_time >= UTC_TIMESTAMP()
           AND is_todo_only = FALSE
           AND (todo_status IS NULL OR todo_status NOT IN ('done', 'cancelled'))`,
        [userId]
      );
      const [unread] = await db.execute(
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
