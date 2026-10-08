// UniHub 0.16 and later run on MariaDB only. MySQL data directories cannot be
// opened by MariaDB, so a MySQL server is refused with a pointer to the upgrade
// notes instead of failing later on a dialect difference.
const MINIMUM_MARIADB = [10, 11];

function parseServerVersion(version: unknown) {
  const text = String(version || '');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return {
    mariadb: /mariadb/i.test(text),
    parts: match ? match.slice(1).map(Number) : null,
  };
}

function supportedServer(version: unknown) {
  const { mariadb, parts } = parseServerVersion(version);
  if (!mariadb || !parts) return false;
  const [major, minor] = parts;
  return major > MINIMUM_MARIADB[0] || (major === MINIMUM_MARIADB[0] && minor >= MINIMUM_MARIADB[1]);
}

function unsupportedServerMessage(version: unknown) {
  const { mariadb } = parseServerVersion(version);
  const minimum = MINIMUM_MARIADB.join('.');
  return mariadb
    ? `MariaDB ${version} is too old. UniHub needs MariaDB ${minimum} or later.`
    : `UniHub needs MariaDB ${minimum} or later, but the database server reports "${version}". `
      + 'Since 0.16.0 UniHub no longer runs on MySQL; see docs/UPGRADING.md (0.16.0).';
}

export { MINIMUM_MARIADB, parseServerVersion, supportedServer, unsupportedServerMessage };
