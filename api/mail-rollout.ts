#!/usr/bin/env node
// Run inside the target image with the deployment's existing database/keys.
// Never starts HTTP, sync, notification or provider workers.
import type { RowDataPacket } from 'mysql2/promise';
import { requireAccountId, prepareRollout, releaseRollout, rolloutStatus } from './src/services/mail-engine/rollout';

async function main(argv = process.argv.slice(2)) {
  const [command, accountId] = argv;
  if (!['prepare', 'release', 'status'].includes(command) || argv.length !== (command === 'status' ? 1 : 2)) {
    throw new Error('Usage: node /app/api/mail-rollout.js prepare CANARY_ACCOUNT_UUID | release ACCOUNT_UUID | status');
  }
  if (command !== 'status') requireAccountId(accountId);
  if (command === 'prepare' && process.env.UNIHUB_MAIL_ROLLOUT_MAINTENANCE !== '1') {
    throw new Error('Prepare requires stopped API/provider writers and UNIHUB_MAIL_ROLLOUT_MAINTENANCE=1');
  }
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const { getDatabaseConfig } = require('./src/services/database-config') as typeof import('./src/services/database-config');
  const state = require('./src/state') as typeof import('./src/state');
  const config = getDatabaseConfig();
  if (!config) throw new Error('Deployment database configuration is required');
  const pool = mysql.createPool({ ...config, timezone: '+00:00', connectionLimit: 2 });
  state.setDb(pool);
  try {
    if (command === 'prepare') {
      // Reject a mistyped account or unsupported cohort before migration DDL.
      const [accounts] = await pool.execute<RowDataPacket[]>('SELECT id,sync_mode FROM mail_accounts WHERE is_active = TRUE');
      if (!accounts.some(a => a.id === accountId) || accounts.some(a => a.sync_mode !== 'sync')) {
        throw new Error('Prepare requires an existing active canary and a Sync-only active account cohort');
      }
      await (require('./src/services/database') as typeof import('./src/services/database')).ensureSchema();
    }
    const result = command === 'prepare' ? await prepareRollout(pool, accountId)
      : command === 'release' ? await releaseRollout(pool, accountId) : await rolloutStatus(pool);
    console.log(JSON.stringify(result));
    return result;
  } finally { await pool.end(); state.setDb(null); }
}
if (require.main === module) main().catch(error => {
  // Avoid logging database connection strings or arbitrary SQL diagnostics.
  console.error(error.code ? `Mail rollout failed (${error.code}); no success was established.` : error.message);
  process.exitCode = 1;
});
export { main };
