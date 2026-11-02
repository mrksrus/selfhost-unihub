// Shared by API connections and the container readiness probe. Keep connection
// credentials and transport defaults identical in both startup paths.
// Both secrets may come from a file (DATABASE_URL_FILE, MYSQL_PASSWORD_FILE;
// config.ts readSecret), which also covers docker/start.sh's readiness wait.
import type { DatabaseConfig } from '../types';
import { readSecret } from '../config';

function getDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig | null {
  const url = readSecret('DATABASE_URL', environment);
  if (url) {
    const dbUrl = new URL(url);
    return {
      host: dbUrl.hostname,
      port: parseInt(dbUrl.port, 10) || 3306,
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      database: dbUrl.pathname.slice(1),
    };
  }

  const host = environment.MYSQL_HOST;
  const port = environment.MYSQL_PORT || '3306';
  const database = environment.MYSQL_DATABASE;
  const user = environment.MYSQL_USER;
  const password = readSecret('MYSQL_PASSWORD', environment);
  if (!host || !database || !user || !password) return null;
  return { host, port: parseInt(port, 10) || 3306, user, password, database };
}

export { getDatabaseConfig };
