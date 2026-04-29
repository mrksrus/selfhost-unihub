const http = require('http');
require('./imap-patch');
const { PORT } = require('./config');
const { db } = require('./state');
const { initDatabase } = require('./services/database');
const { syncMailAccount, isAnyMailAccountSyncRunning } = require('./services/mail');
const { handleRequest } = require('./request-handler');

const MAIL_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let periodicMailSyncRunning = false;

async function start() {
  await initDatabase();
  
  const server = http.createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
  });
  
  // Periodic mail sync every 10 minutes
  setInterval(async () => {
    if (periodicMailSyncRunning || isAnyMailAccountSyncRunning()) {
      console.log('[SYNC] Skipping periodic mail sync because a sync is already running');
      return;
    }

    periodicMailSyncRunning = true;
    try {
      const [accounts] = await db.execute(
        'SELECT id, email_address FROM mail_accounts WHERE is_active = TRUE'
      );
      console.log(`\n[${new Date().toISOString()}] Starting periodic mail sync for ${accounts.length} accounts...`);
      for (const account of accounts) {
        const result = await syncMailAccount(account.id);
        if (result?.success === false) {
          console.error(`Failed to sync ${account.email_address}:`, result.error || 'Unknown error');
        }
      }
    } catch (error) {
      console.error('Periodic sync error:', error);
    } finally {
      periodicMailSyncRunning = false;
    }
  }, MAIL_SYNC_INTERVAL_MS);

  // Clean up expired sessions every hour to prevent table bloat
  setInterval(async () => {
    try {
      const [result] = await db.execute(
        'DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()'
      );
      if (result.affectedRows > 0) {
        console.log(`[CLEANUP] Deleted ${result.affectedRows} expired session(s)`);
      }
    } catch (error) {
      console.error('[CLEANUP] Error cleaning expired sessions:', error.message);
    }
  }, 60 * 60 * 1000); // 1 hour
  
  // Database connection pool health check and cleanup every 15 minutes
  setInterval(async () => {
    try {
      // Test connection pool health with a simple query
      await db.execute('SELECT 1');
      
      // Get pool statistics (mysql2 pool internal structure)
      const pool = db.pool;
      if (pool && pool._allConnections) {
        const totalConnections = pool._allConnections.length || 0;
        const freeConnections = pool._freeConnections?.length || 0;
        const activeConnections = totalConnections - freeConnections;
        const queuedRequests = pool._connectionQueue?.length || 0;
        
        console.log(`[DB POOL] Total: ${totalConnections}, Active: ${activeConnections}, Free: ${freeConnections}, Queued: ${queuedRequests}`);
        
        // If we're using too many connections, log a warning (warn at 80% usage)
        if (activeConnections > 40) {
          console.warn(`[DB POOL] ⚠ High connection usage: ${activeConnections}/50 connections in use`);
        }
        
        // If we have many idle connections, we can let them timeout naturally
        if (freeConnections > 8) {
          console.log(`[DB POOL] Many idle connections (${freeConnections}), will timeout naturally`);
        }
      }
    } catch (error) {
      console.error('[DB POOL] Health check error:', error.message);
      // Try to reconnect if connection is lost
      try {
        await db.execute('SELECT 1');
        console.log('[DB POOL] Reconnection successful');
      } catch (reconnectError) {
        console.error('[DB POOL] Reconnection failed:', reconnectError.message);
      }
    }
  }, 15 * 60 * 1000); // 15 minutes
  
  console.log('✓ Periodic mail sync enabled (every 10 minutes)');
  console.log('✓ Expired session cleanup enabled (every hour)');
  console.log('✓ Database connection pool health check enabled (every 15 minutes)');
}


module.exports = {
  start,
};
