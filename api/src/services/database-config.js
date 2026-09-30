// Shared by API connections and the container readiness probe. Keep connection
// credentials and transport defaults identical in both startup paths.
function getDatabaseConfig(environment = process.env) {
  if (environment.DATABASE_URL) {
    const dbUrl = new URL(environment.DATABASE_URL);
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
  const password = environment.MYSQL_PASSWORD;
  if (!host || !database || !user || !password) return null;
  return { host, port: parseInt(port, 10) || 3306, user, password, database };
}

module.exports = { getDatabaseConfig };
