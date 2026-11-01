// The restore command of the instance backup (docs/DATA_RECOVERY.md
// "Instance backup"). In the image, with the database running and the app
// stopped:
//   docker compose run --rm --no-deps unihub \
//     node /app/api/src/instance-restore.js --file /backup/<name>.uhib --key-file /run/secrets/<key>
// The database and the storage must be empty; the connection is the app's
// own (MYSQL_* or DATABASE_URL, each also as _FILE). --verify-only checks a
// backup with the key and changes nothing. The key comes from --key-file, or
// else INSTANCE_BACKUP_KEY_FILE / INSTANCE_BACKUP_KEY. Exit codes: 0 done,
// 1 refused or failed, 2 wrong usage.
import { decodeKeyText, readSecret } from './config';
import { getDatabaseConfig } from './services/database-config';

const USAGE = `Usage: node instance-restore.js --file <backup.uhib> [--key-file <file>] [--verify-only]

Restores an instance backup into an empty installation (an empty database and
empty storage), or with --verify-only checks it with the key and changes
nothing. The key comes from --key-file, else INSTANCE_BACKUP_KEY_FILE or
INSTANCE_BACKUP_KEY. Start the restored installation with the old
installation's ENCRYPTION_KEY and BACKUP_MASTER_KEY: they are not in the
backup, and stored passwords, two-step sign-in and user backups need them.`;

function parseArgs(argv: readonly string[]) {
  const options: { file?: string; keyFile?: string; verifyOnly: boolean; help: boolean } = { verifyOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--key-file') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value.`);
      if (arg === '--file') options.file = value; else options.keyFile = value;
    } else if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  return options;
}

function readKey(keyFile: string | undefined) {
  const text = readSecret('INSTANCE_BACKUP_KEY', keyFile ? { INSTANCE_BACKUP_KEY_FILE: keyFile } : process.env);
  if (!text) throw new Error('No key: pass --key-file, or set INSTANCE_BACKUP_KEY_FILE or INSTANCE_BACKUP_KEY.');
  const key = decodeKeyText(text);
  if (!key || key.length < 32) throw new Error('The key is not an instance backup key (32 random bytes or more, as hex or base64).');
  return key;
}

function apiOwner(env = process.env) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || !env.UNIHUB_API_UID) return null;
  const uid = Number(env.UNIHUB_API_UID), gid = Number(env.UNIHUB_API_GID || env.UNIHUB_API_UID);
  return Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0 ? { uid, gid } : null;
}

// A command's output for the person running it, not the API log.
const out = (line: string) => { process.stdout.write(`${line}\n`); };
const fail = (line: string) => { process.stderr.write(`${line}\n`); };

async function main(argv: readonly string[], print: (line: string) => void = out) {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) { print(USAGE); return 0; }
  if (!options.file) { fail(`--file is required.\n\n${USAGE}`); return 2; }
  try {
    const key = readKey(options.keyFile);
    const database = getDatabaseConfig();
    if (!database && !options.verifyOnly) throw new Error('No database configuration: set MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD (or DATABASE_URL), as for the app.');
    // Loaded only now: the services read the storage roots from the environment.
    const { restoreInstanceBackup } = require('./services/instance-restore') as typeof import('./services/instance-restore');
    const result = await restoreInstanceBackup({ file: options.file, key, database: database!, verifyOnly: options.verifyOnly, owner: apiOwner(), print });
    print(result.restored
      ? 'Done. Start UniHub with the old installation\'s ENCRYPTION_KEY and BACKUP_MASTER_KEY; everyone signs in again.'
      : 'The backup is complete and readable with this key.');
    return 0;
  } catch (error) {
    // Messages name files and settings, never a key or a password.
    fail(`Instance restore refused: ${(error as Error).message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

export { main, parseArgs };
