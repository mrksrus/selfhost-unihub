// UniHub API Server
// Backend API for self-hosted deployments

import { start } from './src/app';

// A failed startup (database, migrations, inventory check) never listens. Exit
// so the supervisor restarts it rather than keeping a process that serves nothing.
start().catch(error => {
  console.error('[PROCESS] Startup failed, exiting:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
