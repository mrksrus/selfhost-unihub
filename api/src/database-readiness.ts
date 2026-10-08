import type { DatabaseConfig } from './types';
import type { Connection, ConnectionOptions } from 'mysql2';

import mysql from 'mysql2';
import { performance } from 'node:perf_hooks';
import { getDatabaseConfig } from './services/database-config';

interface ProbeOptions {
  timeoutMs: number;
  createConnection?: (options: ConnectionOptions) => Pick<Connection, 'promise' | 'destroy'>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
interface WaitOptions {
  maxWaitMs?: number;
  intervalMs?: number;
  probe?: typeof probeDatabase;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  log?: (message: string) => void;
}

function seconds(value: unknown, fallback: number, allowZero = false) {
  if (!/^\d+$/.test(String(value ?? ''))) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback;
}

async function probeDatabase(config: DatabaseConfig, {
  timeoutMs,
  createConnection = mysql.createConnection,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: ProbeOptions) {
  // Use the same driver and transport defaults as the API, not CLI TLS defaults.
  const connection = createConnection({ ...config, timezone: '+00:00', connectTimeout: timeoutMs });
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimer(() => {
        const error: NodeJS.ErrnoException = new Error('MariaDB readiness timed out');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs);
    });
    // SELECT1 verifies authentication and access to the configured database.
    await Promise.race([connection.promise().query('SELECT 1'), deadline]);
  } finally {
    clearTimer(timer);
    // Destroy also closes a stalled handshake/authentication, not just TCP connect.
    connection.destroy();
  }
}

async function waitForDatabase(config: DatabaseConfig | null, {
  maxWaitMs = 300000,
  intervalMs = 5000,
  probe = probeDatabase,
  now = () => performance.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  log = console.log,
}: WaitOptions = {}) {
  if (!config) throw new Error('Missing database configuration');
  const startedAt = now();
  log(`⏳ Waiting for MariaDB at ${config.host}:${config.port} (checking every ${intervalMs / 1000}s for up to ${maxWaitMs / 1000}s)...`);
  while (now() - startedAt < maxWaitMs) {
    const remaining = maxWaitMs - (now() - startedAt);
    try {
      await probe(config, { timeoutMs: Math.max(1, Math.min(5000, Math.ceil(remaining))) });
      log('✓ MariaDB is ready! (authenticated with API driver)');
      return true;
    } catch {
      // Do not print driver errors, which may contain credentials or connection URLs.
      const elapsed = now() - startedAt;
      if (elapsed >= maxWaitMs) break;
      log(`  Still waiting... (${Math.floor(elapsed / 1000)}s/${maxWaitMs / 1000}s)`);
      await sleep(Math.min(intervalMs, maxWaitMs - elapsed));
    }
  }
  log(`⚠ MariaDB took longer than expected (waited ${Math.ceil((now() - startedAt) / 1000)}s), but continuing anyway...`);
  return false;
}

if (require.main === module) {
  Promise.resolve().then(() => waitForDatabase(getDatabaseConfig(), {
    maxWaitMs: seconds(process.env.MYSQL_STARTUP_MAX_WAIT_SECONDS, 300, true) * 1000,
    intervalMs: seconds(process.env.MYSQL_STARTUP_CHECK_INTERVAL_SECONDS, 5) * 1000,
  })).then(ready => { process.exitCode = ready ? 0 : 1; }).catch(() => {
    console.error('⚠ MariaDB readiness could not load the API database configuration; continuing to API startup...');
    process.exitCode = 1;
  });
}

export { probeDatabase, waitForDatabase, seconds };
