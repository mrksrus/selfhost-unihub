const PORT = process.env.PORT || 4000;
// Unset (the image) listens on every interface of the container; a host run
// such as tools/e2e sets 127.0.0.1 so the API is reachable only through nginx.
const API_LISTEN_HOST = process.env.API_LISTEN_HOST || undefined;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
// The key before the last change: stored values encrypted with it stay readable.
const ENCRYPTION_KEY_PREVIOUS = process.env.ENCRYPTION_KEY_PREVIOUS || '';
const BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || ENCRYPTION_KEY;
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(value => value.trim()).filter(Boolean);
const TRUSTED_MAIL_HOSTS = (process.env.TRUSTED_MAIL_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);
const CALENDAR_MULTI_ENABLED = process.env.CALENDAR_MULTI_ENABLED !== 'false';
const AUTH_COOKIE_NAME = 'auth-token';
// Secure cookies need HTTPS; local HTTP development starts the API without
// NODE_ENV=production. The image sets it (Dockerfile).
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const MIN_PASSWORD_LENGTH = 12;
const BACKUP_UPLOAD_MAX_SIZE = 3900 * 1024 * 1024;
// A 25 MiB attachment payload expands to roughly 33.4 MiB when base64 encoded.
// Leave room for JSON metadata and the message body as well.
const MAIL_COMPOSE_REQUEST_MAX_SIZE = 40 * 1024 * 1024;

export {
  PORT,
  API_LISTEN_HOST,
  JWT_SECRET,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_PREVIOUS,
  BACKUP_MASTER_KEY,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  ALLOWED_ORIGINS,
  TRUST_PROXY_HEADERS,
  TRUSTED_PROXY_CIDRS,
  TRUSTED_MAIL_HOSTS,
  CALENDAR_MULTI_ENABLED,
  AUTH_COOKIE_NAME,
  COOKIE_SECURE,
  MIN_PASSWORD_LENGTH,
  BACKUP_UPLOAD_MAX_SIZE,
  MAIL_COMPOSE_REQUEST_MAX_SIZE,
};
