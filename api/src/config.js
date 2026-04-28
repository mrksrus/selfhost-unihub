const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const TRUSTED_MAIL_HOSTS = (process.env.TRUSTED_MAIL_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);
const CALENDAR_MULTI_ENABLED = process.env.CALENDAR_MULTI_ENABLED !== 'false';
const AUTH_COOKIE_NAME = 'auth-token';
const MIN_PASSWORD_LENGTH = 12;

module.exports = {
  PORT,
  JWT_SECRET,
  ENCRYPTION_KEY,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  ALLOWED_ORIGINS,
  TRUST_PROXY_HEADERS,
  TRUSTED_MAIL_HOSTS,
  CALENDAR_MULTI_ENABLED,
  AUTH_COOKIE_NAME,
  MIN_PASSWORD_LENGTH,
};
