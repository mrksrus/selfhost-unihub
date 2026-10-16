// Disposable, independent UniHub installations for release checks. Each one has
// its own MariaDB server, uploads directory, keys and API process, so nothing
// is shared but the machine. Two kinds:
//
// - container: the candidate image and a mariadb:11.8 container on a private
//   Docker network (CI). The app listens on a loopback port of this machine.
// - local: the built API (api/dist) and MariaDB from the official tarball
//   (scripts/local-db.sh, UNIHUB_DB_HOME), each API in a bubblewrap mount
//   namespace whose /app/uploads is its own directory. No Docker needed.
//
// Neither kind ever touches a database, volume or directory it did not create.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const repo = path.resolve(import.meta.dirname, '..');
/** Mail and calendar test peers are reached under this name from every installation. */
export const PEER_HOST = 'peer.unihub.test';

export interface InstallationOptions {
  name: string;
  adminEmail: string;
  adminPassword: string;
  /** A CA certificate the installation trusts in addition to the system's (test peers). */
  caFile?: string;
  /** Browser origins allowed to call the API (ALLOWED_ORIGINS). */
  allowedOrigins?: string;
}

export interface Installation {
  readonly name: string;
  readonly kind: 'container' | 'local';
  /** Base URL for HTTP requests, without a trailing slash. */
  url: string;
  /** Runs a CommonJS TypeScript script inside the installation as its API user, with its configuration. */
  exec(script: string, env?: Record<string, string>): string;
  /** Stops and starts the app and its database; the data stays. */
  restart(): Promise<void>;
  /** Removes the installation with its database, files and keys. */
  destroy(): Promise<void>;
  logs(): string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const secret = () => crypto.randomBytes(24).toString('base64url');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHealth(url: string, isAlive: () => boolean, seconds = 240) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error(`${url}: the installation stopped before it became healthy`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json() as { database?: string }).database === 'ok') return;
    } catch { /* not listening yet */ }
    await sleep(1000);
  }
  throw new Error(`${url} did not become healthy within ${seconds} seconds`);
}

function run(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: options.timeout ?? 120000, input: options.input, env: options.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** A self-signed CA and a certificate for PEER_HOST it signed, for strict TLS against test peers. */
export function createPeerCertificates(directory: string) {
  const file = (name: string) => path.join(directory, name);
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=UniHub disposable test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', file('ca.key'), '-out', file('ca.pem')]);
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${PEER_HOST}`, '-keyout', file('peer.key'), '-out', file('peer.csr')]);
  fs.writeFileSync(file('peer.ext'), `subjectAltName=DNS:${PEER_HOST}\nextendedKeyUsage=serverAuth\n`);
  run('openssl', ['x509', '-req', '-in', file('peer.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-days', '2', '-extfile', file('peer.ext'), '-out', file('peer.pem')]);
  fs.chmodSync(file('ca.pem'), 0o644);
  return { ca: file('ca.pem'), cert: fs.readFileSync(file('peer.pem')), key: fs.readFileSync(file('peer.key')) };
}

// ── Container installations ──────────────────────────────────────────────

function docker(...args: string[]) { return run('docker', args, { timeout: 300000 }).trim(); }

export async function startContainerInstallation(image: string, options: InstallationOptions): Promise<Installation> {
  const id = `unihub-fresh-${options.name}-${process.env.GITHUB_RUN_ID || 'local'}-${crypto.randomBytes(3).toString('hex')}`;
  const network = id, db = `${id}-db`, app = `${id}-app`, uploads = `${id}-uploads`, dbVolume = `${id}-mariadb`;
  const dbPassword = secret();
  const port = await freePort();
  const destroy = async () => {
    for (const name of [app, db]) spawnSync('docker', ['rm', '-f', '-v', name]);
    for (const volume of [uploads, dbVolume]) spawnSync('docker', ['volume', 'rm', volume]);
    spawnSync('docker', ['network', 'rm', network]);
  };
  try {
    docker('image', 'inspect', image);
    docker('network', 'create', network);
    docker('volume', 'create', uploads);
    docker('volume', 'create', dbVolume);
    // Same server settings as docker-compose.yml.
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db',
      '-e', 'MARIADB_DATABASE=unihub', '-e', 'MARIADB_USER=unihub', '-e', `MARIADB_PASSWORD=${dbPassword}`, '-e', `MARIADB_ROOT_PASSWORD=${secret()}`,
      '--mount', `type=volume,source=${dbVolume},target=/var/lib/mysql`, 'mariadb:11.8',
      '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--innodb-snapshot-isolation=OFF',
      '--innodb-flush-log-at-trx-commit=2', '--skip-name-resolve', '--local-infile=0');
    const env = {
      NODE_ENV: 'production', MYSQL_HOST: 'db', MYSQL_PORT: '3306', MYSQL_DATABASE: 'unihub', MYSQL_USER: 'unihub', MYSQL_PASSWORD: dbPassword,
      JWT_SECRET: secret(), ENCRYPTION_KEY: secret(), BACKUP_MASTER_KEY: secret(),
      BOOTSTRAP_ADMIN_EMAIL: options.adminEmail, BOOTSTRAP_ADMIN_PASSWORD: options.adminPassword,
      TRUSTED_MAIL_HOSTS: PEER_HOST, MYSQL_STARTUP_MAX_WAIT_SECONDS: '120', MYSQL_STARTUP_CHECK_INTERVAL_SECONDS: '2',
      ...(options.caFile ? { NODE_EXTRA_CA_CERTS: '/run/unihub-test/ca.pem' } : {}),
      ...(options.allowedOrigins ? { ALLOWED_ORIGINS: options.allowedOrigins } : {}),
    };
    // The reference Compose restrictions, as in scripts/container-smoke.sh.
    docker('run', '-d', '--name', app, '--network', network, '-p', `127.0.0.1:${port}:80`,
      '--add-host', `${PEER_HOST}:host-gateway`,
      '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'NET_BIND_SERVICE', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
      '--mount', `type=volume,source=${uploads},target=/app/uploads`,
      ...(options.caFile ? ['--mount', `type=bind,source=${options.caFile},target=/run/unihub-test/ca.pem,readonly`] : []),
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image);
    const url = `http://127.0.0.1:${port}`;
    const running = (name: string) => { try { return docker('inspect', '--format', '{{.State.Running}}', name) === 'true'; } catch { return false; } };
    const installation: Installation = {
      name: options.name, kind: 'container', url,
      exec(script, extra = {}) {
        return run('docker', ['exec', '-i', '-u', '10001:10001', '-e', 'UNIHUB_API_ROOT=/app/api',
          ...Object.entries(extra).flatMap(([key, value]) => ['-e', `${key}=${value}`]), app,
          'node', '--input-type=commonjs-typescript'], { input: script, timeout: 180000 });
      },
      async restart() {
        docker('stop', '-t', '30', app);
        docker('restart', '-t', '30', db);
        docker('start', app);
        await waitForHealth(url, () => running(app));
      },
      destroy,
      logs() {
        const result = spawnSync('docker', ['logs', '--tail', '150', app], { encoding: 'utf8' });
        return `${result.stdout || ''}${result.stderr || ''}`;
      },
    };
    await waitForHealth(url, () => running(app));
    return installation;
  } catch (error) {
    const log = spawnSync('docker', ['logs', '--tail', '150', app], { encoding: 'utf8' });
    console.error(log.stdout || log.stderr || 'No app log was created.');
    await destroy();
    throw error;
  }
}

// ── Local installations ──────────────────────────────────────────────────

interface Pool { query(sql: string): Promise<unknown>; end(): Promise<void> }
const mysql = () => createRequire(path.join(repo, 'api/package.json'))('mysql2/promise') as { createConnection(config: Record<string, unknown>): Promise<Pool> };

/** Arguments that rebuild this machine's file system in a new mount namespace with a private /app. */
function sandboxArgs(uploads: string, hostsFile: string) {
  const args = ['--die-with-parent', '--tmpfs', '/'];
  for (const entry of fs.readdirSync('/')) {
    const target = `/${entry}`;
    if (entry === 'app') continue;
    if (entry === 'proc') args.push('--proc', '/proc');
    else if (entry === 'dev') args.push('--dev-bind', '/dev', '/dev');
    else if (fs.lstatSync(target).isSymbolicLink()) args.push('--symlink', fs.readlinkSync(target), target);
    else args.push('--bind', target, target);
  }
  return [...args, '--bind', uploads, '/app/uploads', '--ro-bind', hostsFile, '/etc/hosts'];
}

export async function startLocalInstallation(options: InstallationOptions): Promise<Installation> {
  const dbHome = process.env.UNIHUB_DB_HOME || path.join(os.homedir(), '.local/opt/mariadb-11.8');
  if (!fs.existsSync(path.join(dbHome, 'bin/mariadbd'))) throw new Error(`MariaDB not found at ${dbHome} (see docs/DEVELOPMENT.md)`);
  if (spawnSync('bwrap', ['--version']).status !== 0) throw new Error('Local installations need bubblewrap (bwrap) for a private /app/uploads.');
  if (!fs.existsSync(path.join(repo, 'api/dist/server.js'))) throw new Error('Build the API first: npm --prefix api run build');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `unihub-fresh-${options.name}-`));
  try {
    const dir = (name: string) => { const value = path.join(root, name); fs.mkdirSync(value, { recursive: true }); return value; };
    const data = dir('mariadb'), uploads = dir('uploads'), run_ = dir('run');
    const socket = path.join(run_, 'mariadbd.sock');
    const dbPort = await freePort(), port = await freePort();
    fs.writeFileSync(path.join(root, 'mariadb.cnf'), `[mariadbd]
  basedir = ${dbHome}
  datadir = ${data}
  socket = ${socket}
  pid-file = ${run_}/mariadbd.pid
  log-error = ${root}/mariadb.err
  bind-address = 127.0.0.1
  port = ${dbPort}
  skip-log-bin
  character-set-server = utf8mb4
  collation-server = utf8mb4_unicode_ci
  default-time-zone = '+00:00'
  innodb_buffer_pool_size = 128M
  innodb_snapshot_isolation = OFF
  innodb_flush_log_at_trx_commit = 2
  skip-name-resolve
  local_infile = 0
  performance_schema = OFF
  `);
    const cnf = `--defaults-file=${path.join(root, 'mariadb.cnf')}`;
    run(path.join(dbHome, 'scripts/mariadb-install-db'), [cnf, '--auth-root-authentication-method=normal', '--skip-test-db']);
    const hostsFile = path.join(root, 'hosts');
    fs.writeFileSync(hostsFile, `127.0.0.1 localhost ${PEER_HOST}\n::1 localhost\n`);
    const dbPassword = secret();
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: dir('tmp'),
      NODE_ENV: 'production', PORT: String(port), MYSQL_HOST: '127.0.0.1', MYSQL_PORT: String(dbPort), MYSQL_DATABASE: 'unihub',
      MYSQL_USER: 'unihub', MYSQL_PASSWORD: dbPassword, JWT_SECRET: secret(), ENCRYPTION_KEY: secret(), BACKUP_MASTER_KEY: secret(),
      BOOTSTRAP_ADMIN_EMAIL: options.adminEmail, BOOTSTRAP_ADMIN_PASSWORD: options.adminPassword,
      TRUSTED_MAIL_HOSTS: PEER_HOST, MYSQL_STARTUP_MAX_WAIT_SECONDS: '60', MYSQL_STARTUP_CHECK_INTERVAL_SECONDS: '1',
      UNIHUB_DOWNLOADS_DIR: dir('downloads'),
      ...(options.caFile ? { NODE_EXTRA_CA_CERTS: options.caFile } : {}),
      ...(options.allowedOrigins ? { ALLOWED_ORIGINS: options.allowedOrigins } : {}),
    };
    let database: ChildProcess | null = null, api: ChildProcess | null = null;
    const log = path.join(root, 'api.log');
    const startDatabase = async () => {
      database = spawn(path.join(dbHome, 'bin/mariadbd'), [cnf], { stdio: 'ignore', detached: false });
      for (let attempt = 0; attempt < 120; attempt++) {
        if (database.exitCode !== null) break;
        if (fs.existsSync(socket)) {
          try { const connection = await mysql().createConnection({ socketPath: socket, user: 'root' }); await connection.end(); return; } catch { /* starting */ }
        }
        await sleep(500);
      }
      throw new Error(`MariaDB for ${options.name} did not start:\n${fs.existsSync(path.join(root, 'mariadb.err')) ? fs.readFileSync(path.join(root, 'mariadb.err'), 'utf8').slice(-2000) : ''}`);
    };
    const stopProcess = async (child: ChildProcess | null) => {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(30000)]);
      if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    };
    const startApi = async () => {
      const output = fs.openSync(log, 'a');
      api = spawn('bwrap', [...sandboxArgs(uploads, hostsFile), '--clearenv', ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]),
        '--chdir', path.join(repo, 'api'), process.execPath, path.join(repo, 'api/dist/server.js')], { stdio: ['ignore', output, output] });
      fs.closeSync(output);
      const child = api;
      await waitForHealth(url, () => child.exitCode === null && !child.signalCode);
    };
    const url = `http://127.0.0.1:${port}`;
    const installation: Installation = {
      name: options.name, kind: 'local', url,
      exec(script, extra = {}) {
        return run('bwrap', [...sandboxArgs(uploads, hostsFile), '--clearenv',
          ...Object.entries({ ...env, ...extra, UNIHUB_API_ROOT: path.join(repo, 'api/dist') }).flatMap(([key, value]) => ['--setenv', key, value]),
          '--chdir', path.join(repo, 'api'), process.execPath, '--input-type=commonjs-typescript'], { input: script, timeout: 180000 });
      },
      async restart() {
        await stopProcess(api);
        await stopProcess(database);
        await startDatabase();
        await startApi();
      },
      async destroy() {
        await stopProcess(api);
        await stopProcess(database);
        fs.rmSync(root, { recursive: true, force: true });
      },
      logs() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-150).join('\n') : ''; },
    };
    try {
      await startDatabase();
      const connection = await mysql().createConnection({ socketPath: socket, user: 'root', multipleStatements: true });
      try {
        await connection.query(`CREATE DATABASE unihub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
          CREATE USER 'unihub'@'127.0.0.1' IDENTIFIED BY '${dbPassword}'; GRANT ALL PRIVILEGES ON unihub.* TO 'unihub'@'127.0.0.1';`);
      } finally { await connection.end(); }
      await startApi();
    } catch (error) {
      console.error(installation.logs());
      await installation.destroy();
      throw error;
    }
    return installation;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Chooses the kind from the command line: --image <image> or --local. */
export function installationFactory(argv = process.argv.slice(2)) {
  const imageIndex = argv.indexOf('--image');
  if (imageIndex >= 0 && argv[imageIndex + 1]) {
    const image = argv[imageIndex + 1];
    const id = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).stdout?.trim();
    if (!id) throw new Error(`Docker image ${image} is not available`);
    return { describe: `container image ${image} (${id})`, start: (options: InstallationOptions) => startContainerInstallation(image, options) };
  }
  if (argv.includes('--local')) return { describe: 'local build (api/dist) with MariaDB from UNIHUB_DB_HOME', start: startLocalInstallation };
  throw new Error('Choose the installations: --image <image> (Docker) or --local (built API, MariaDB tarball, bubblewrap).');
}

// ── HTTP as a browser signs in ───────────────────────────────────────────

interface RequestOptions { expected?: number | number[]; headers?: Record<string, string>; raw?: boolean }

/** One signed-in browser: cookies, the CSRF token and JSON or byte responses. */
export class Session {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  readonly base: string;
  constructor(base: string) { this.base = base; }

  async send(method: string, path: string, body?: unknown, { expected = 200, headers = {}, raw = false }: RequestOptions = {}) {
    const response = await fetch(this.base + path, {
      method, signal: AbortSignal.timeout(60000),
      headers: { ...(body === undefined || raw ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(this.csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body as Uint8Array : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const statuses = Array.isArray(expected) ? expected : [expected];
    if (!statuses.includes(response.status)) {
      throw new Error(`${method} ${path}: expected ${statuses.join(' or ')}, got ${response.status} ${(await response.text()).slice(0, 500)}`);
    }
    return response;
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const data = await (await this.send(method, path, body, options)).json() as T & { csrfToken?: string };
    if (data && typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
    return data;
  }

  async bytes(path: string, options: RequestOptions = {}) {
    return Buffer.from(await (await this.send('GET', path, undefined, options)).arrayBuffer());
  }

  async signIn(email: string, password: string) {
    return this.json<{ user: { id: string; email: string; role: string } }>('POST', '/api/auth/signin', { email, password });
  }
}
