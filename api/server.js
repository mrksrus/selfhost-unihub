// UniHub API Server
// Backend API for self-hosted deployments

const http = require('http');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unihub-encryption-key-for-email-credentials-change-me';

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(ENCRYPTION_KEY);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(encryptedText) {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = deriveKey(ENCRYPTION_KEY);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// ── Mail sync and send functions ──────────────────────────────────

async function syncMailAccount(accountId) {
  try {
    const [accounts] = await db.execute(
      'SELECT * FROM mail_accounts WHERE id = ?',
      [accountId]
    );
    if (!accounts[0]) {
      console.error(`Account ${accountId} not found`);
      return;
    }

    const account = accounts[0];
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) {
      console.error(`No password for account ${accountId}`);
      return;
    }

    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: account.imap_port || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    };

    console.log(`Syncing ${account.email_address}...`);
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Fetch emails from last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const sinceDate = threeMonthsAgo.toLocaleDateString('en-US', { 
      day: '2-digit', 
      month: 'short', 
      year: 'numeric' 
    }).replace(/,/g, ''); // Format: "DD MMM YYYY"
    
    const searchCriteria = ['SINCE', sinceDate];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: false,
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`Found ${messages.length} messages from last 3 months for ${account.email_address}`);

    // Limit to 500 messages max to avoid overwhelming the database
    const messagesToSync = messages.slice(-500);
    console.log(`Syncing ${messagesToSync.length} messages...`);

    for (const item of messagesToSync) {
      const all = item.parts.find(p => p.which === '');
      const id = item.attributes.uid;
      const idHeader = `Imap-ID: ${id}`;
      const rawEmail = all ? all.body : '';

      const parsed = await simpleParser(idHeader + '\r\n' + rawEmail);
      const messageId = parsed.messageId || `${account.id}-${id}`;

      // Check if already synced
      const [existing] = await db.execute(
        'SELECT id FROM emails WHERE message_id = ? AND mail_account_id = ?',
        [messageId, accountId]
      );
      if (existing.length > 0) continue;

      // Insert email
      const emailId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          emailId,
          account.user_id,
          accountId,
          messageId,
          parsed.subject || '(No subject)',
          parsed.from?.value?.[0]?.address || parsed.from?.text || 'unknown',
          parsed.from?.value?.[0]?.name || null,
          JSON.stringify((parsed.to?.value || []).map(t => t.address)),
          parsed.text || null,
          parsed.html || null,
          parsed.date || new Date(),
        ]
      );
    }

    connection.end();

    // Update last synced
    await db.execute(
      'UPDATE mail_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ?',
      [accountId]
    );

    console.log(`✓ Synced ${account.email_address}`);
  } catch (error) {
    console.error(`Error syncing account ${accountId}:`, error.message);
  }
}

async function sendEmail(accountId, { to, subject, body, isHtml = false }) {
  try {
    const [accounts] = await db.execute(
      'SELECT * FROM mail_accounts WHERE id = ?',
      [accountId]
    );
    if (!accounts[0]) throw new Error('Account not found');

    const account = accounts[0];
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) throw new Error('No password configured');

    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port || 587,
      secure: account.smtp_port === 465,
      auth: {
        user: account.username || account.email_address,
        pass: password,
      },
    });

    const info = await transporter.sendMail({
      from: `${account.display_name || account.email_address} <${account.email_address}>`,
      to,
      subject,
      text: isHtml ? undefined : body,
      html: isHtml ? body : undefined,
    });

    console.log(`✓ Sent email from ${account.email_address}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending email from account ${accountId}:`, error.message);
    throw error;
  }
}

// Database connection pool
let db;

function getDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.MYSQL_HOST;
  const port = process.env.MYSQL_PORT || '3306';
  const database = process.env.MYSQL_DATABASE;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;

  if (!host || !database || !user || !password) {
    return null;
  }

  return `mysql://${user}:${password}@${host}:${port}/${database}`;
}

async function initDatabase() {
  if (!JWT_SECRET) {
    console.error('✗ Missing JWT_SECRET. Set it in docker-compose.yml before starting.');
    process.exit(1);
  }
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    console.error('✗ Missing database configuration. Set DATABASE_URL or MYSQL_* in docker-compose.yml.');
    process.exit(1);
  }

  const dbUrl = new URL(databaseUrl);
  const poolConfig = {
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port, 10) || 3306,
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00', // interpret DATETIME as UTC (we store UTC)
  };

  // Retry connection — MySQL may still be starting
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      db = mysql.createPool(poolConfig);
      await db.execute('SELECT 1');
      console.log('✓ Database connected');
      break;
    } catch (error) {
      // Clean up the failed pool before retrying
      if (db) { await db.end().catch(() => {}); db = null; }
      if (attempt === 15) {
        console.error('✗ Database connection failed after 15 attempts:', error.message);
        process.exit(1);
      }
      console.log(`⏳ Waiting for database (attempt ${attempt}/15)…`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await ensureSchema();
}

// ── Auto-create tables & seed admin user on first run ─────────────
async function ensureSchema() {
  console.log('Checking database schema…');

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    token VARCHAR(512) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_token (token),
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS contacts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    company VARCHAR(255),
    job_title VARCHAR(255),
    notes TEXT,
    avatar_url TEXT,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_contacts_user (user_id),
    INDEX idx_contacts_name (first_name, last_name),
    INDEX idx_contacts_email (email),
    INDEX idx_contacts_favorite (user_id, is_favorite)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_events (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    all_day BOOLEAN DEFAULT FALSE,
    location VARCHAR(500),
    color VARCHAR(20) DEFAULT '#22c55e',
    recurrence VARCHAR(100),
    reminder_minutes INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_events_user (user_id),
    INDEX idx_events_start (start_time),
    INDEX idx_events_user_time (user_id, start_time, end_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    provider VARCHAR(50) NOT NULL,
    username VARCHAR(255),
    imap_host VARCHAR(255),
    imap_port INT DEFAULT 993,
    smtp_host VARCHAR(255),
    smtp_port INT DEFAULT 587,
    encrypted_password TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_mail_accounts_user (user_id),
    INDEX idx_mail_accounts_email (email_address),
    UNIQUE KEY unique_user_email (user_id, email_address)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Add username column if it doesn't exist (migration for existing installs)
  try {
    await db.execute(`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS username VARCHAR(255) AFTER provider`);
  } catch (e) {
    // Column might already exist or unsupported syntax, ignore
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS emails (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NOT NULL,
    message_id VARCHAR(500),
    subject TEXT,
    from_address VARCHAR(255) NOT NULL,
    from_name VARCHAR(255),
    to_addresses JSON NOT NULL,
    cc_addresses JSON,
    bcc_addresses JSON,
    body_text LONGTEXT,
    body_html LONGTEXT,
    folder VARCHAR(50) DEFAULT 'inbox',
    is_read BOOLEAN DEFAULT FALSE,
    is_starred BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE,
    has_attachments BOOLEAN DEFAULT FALSE,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    INDEX idx_emails_user (user_id),
    INDEX idx_emails_account (mail_account_id),
    INDEX idx_emails_folder (mail_account_id, folder),
    INDEX idx_emails_date (received_at DESC),
    INDEX idx_emails_unread (user_id, is_read, received_at DESC),
    FULLTEXT INDEX ft_emails_search (subject, body_text)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS email_attachments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    INDEX idx_attachments_email (email_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Seed default admin user if no users exist yet
  const [rows] = await db.execute('SELECT COUNT(*) as count FROM users');
  if (rows[0].count === 0) {
    const adminHash = await hashPassword('admin123');
    await db.execute(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, role)
       VALUES (UUID(), 'admin@unihub.local', ?, 'Admin User', TRUE, 'admin')`,
      [adminHash]
    );
    console.log('✓ Default admin created (admin@unihub.local / admin123)');
  }

  console.log('✓ Database schema ready');
}

// Password hashing
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign(
    { userId, sub: userId },
    JWT_SECRET,
    { expiresIn: '21d' }
  );
}

function getSessionExpiry() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 21);
  return expiresAt;
}

// ── Rate limiting (in-memory) ──────────────────────────────────────
const rateLimitStore = new Map();
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BLOCK_MS = 300 * 60 * 1000; // 300 minutes

function getClientIP(req) {
  return req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry) return null;
  if (entry.blockedUntil > now) {
    return Math.ceil((entry.blockedUntil - now) / 60000);
  }
  if (entry.blockedUntil > 0) {
    rateLimitStore.delete(ip);
  }
  return null;
}

function recordFailedAttempt(ip) {
  const entry = rateLimitStore.get(ip) || { failures: 0, blockedUntil: 0 };
  entry.failures++;
  if (entry.failures >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.blockedUntil = Date.now() + RATE_LIMIT_BLOCK_MS;
  }
  rateLimitStore.set(ip, entry);
}

function resetRateLimit(ip) {
  rateLimitStore.delete(ip);
}

// Clean up expired rate-limit entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (entry.blockedUntil > 0 && entry.blockedUntil < now) {
      rateLimitStore.delete(ip);
    }
  }
}, 3600000);

// JWT verification + session check
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }

  try {
    const [sessions] = await db.execute(
      'SELECT user_id, expires_at FROM sessions WHERE token = ? LIMIT 1',
      [token]
    );

    if (sessions.length === 0) return null;
    const session = sessions[0];
    if (new Date(session.expires_at) < new Date()) return null;

    return session.user_id || decoded.userId || decoded.sub;
  } catch {
    return null;
  }
}

// Admin check
async function isAdmin(userId) {
  if (!userId) return false;
  try {
    const [users] = await db.execute('SELECT role FROM users WHERE id = ?', [userId]);
    return users.length > 0 && users[0].role === 'admin';
  } catch {
    return false;
  }
}

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (body.length > maxSize) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ── vCard helpers (3.0, compatible with Google & Apple) ──────────
function escapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

function decodeQuotedPrintable(str) {
  return str.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function contactToVCard(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const ln = escapeVCard(c.last_name || '');
  const fn = escapeVCard(c.first_name || '');
  lines.push(`N:${ln};${fn};;;`);
  lines.push(`FN:${escapeVCard([c.first_name, c.last_name].filter(Boolean).join(' '))}`);
  if (c.email)     lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(c.email)}`);
  if (c.phone)     lines.push(`TEL;TYPE=CELL:${escapeVCard(c.phone)}`);
  if (c.company)   lines.push(`ORG:${escapeVCard(c.company)}`);
  if (c.job_title) lines.push(`TITLE:${escapeVCard(c.job_title)}`);
  if (c.notes)     lines.push(`NOTE:${escapeVCard(c.notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function parseVCards(vcfData) {
  // Unfold continuation lines (RFC 2425 §5.8.1)
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const contacts = [];
  const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

  for (const block of blocks) {
    if (!block.trim().match(/^BEGIN:VCARD/i)) continue;
    if (!block.match(/END:VCARD/i)) continue;

    const contact = {
      first_name: '', last_name: null, email: null,
      phone: null, company: null, job_title: null, notes: null,
    };

    for (const line of block.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const propFull = line.substring(0, colonIdx).toUpperCase();
      let value = line.substring(colonIdx + 1).trim();
      const propName = propFull.split(';')[0];

      // Handle quoted-printable encoding (used by some Apple exports)
      if (propFull.includes('ENCODING=QUOTED-PRINTABLE')) {
        value = decodeQuotedPrintable(value);
      }

      value = unescapeVCard(value);

      switch (propName) {
        case 'N': {
          const parts = value.split(';');
          contact.last_name = parts[0] || null;
          contact.first_name = parts[1] || '';
          break;
        }
        case 'FN':
          // Only use FN as fallback if N wasn't parsed
          if (!contact.first_name) {
            const parts = value.split(' ');
            contact.first_name = parts[0] || '';
            contact.last_name = parts.slice(1).join(' ') || null;
          }
          break;
        case 'EMAIL':
          if (!contact.email) contact.email = value;
          break;
        case 'TEL':
          if (!contact.phone) contact.phone = value;
          break;
        case 'ORG':
          contact.company = value.split(';')[0] || null;
          break;
        case 'TITLE':
          contact.job_title = value || null;
          break;
        case 'NOTE':
          contact.notes = value || null;
          break;
      }
    }

    // Must have at least a name
    if (contact.first_name || contact.last_name) {
      if (!contact.first_name && contact.last_name) {
        contact.first_name = contact.last_name;
        contact.last_name = null;
      }
      contacts.push(contact);
    }
  }

  return contacts;
}

// Simple router
const routes = {
  'GET /health': async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  
  // Authentication endpoints
  'POST /api/auth/signup': async (req, userId, body) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    const { email, password, full_name } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    
    try {
      // Check if user exists
      const [existing] = await db.execute(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
      
      if (existing.length > 0) {
        recordFailedAttempt(ip);
        return { error: 'User already exists', status: 400 };
      }
      
      // Create user
      const passwordHash = await hashPassword(password);
      const newUserId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES (?, ?, ?, ?, TRUE)',
        [newUserId, email, passwordHash, full_name || null]
      );
      
      const token = generateToken(newUserId);
      
      // Create session
      const expiresAt = getSessionExpiry();
      await db.execute(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [newUserId, token, expiresAt]
      );
      
      resetRateLimit(ip);
      return { token, user: { id: newUserId, email, full_name, role: 'user' } };
    } catch (error) {
      console.error('Signup error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to create user', status: 500 };
    }
  },
  
  'POST /api/auth/signin': async (req, userId, body) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    const { email, password } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    
    try {
      const [users] = await db.execute(
        'SELECT id, email, password_hash, full_name, role FROM users WHERE email = ?',
        [email]
      );
      
      if (users.length === 0) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      const user = users[0];
      const isValid = await verifyPassword(password, user.password_hash);
      
      if (!isValid) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      const token = generateToken(user.id);
      
      // Create session
      const expiresAt = getSessionExpiry();
      await db.execute(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [user.id, token, expiresAt]
      );
      
      resetRateLimit(ip);
      return { token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } };
    } catch (error) {
      console.error('Signin error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to sign in', status: 500 };
    }
  },
  
  'POST /api/auth/signout': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
      }
      return { message: 'Signed out successfully' };
    } catch (error) {
      return { error: 'Failed to sign out', status: 500 };
    }
  },
  
  'GET /api/auth/me': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }
      
      return { user: users[0] };
    } catch (error) {
      return { error: 'Failed to get user', status: 500 };
    }
  },

  'PUT /api/auth/password': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { current_password, new_password } = body;
    if (!current_password || !new_password) {
      return { error: 'Current password and new password are required', status: 400 };
    }
    if (new_password.length < 6) {
      return { error: 'New password must be at least 6 characters', status: 400 };
    }

    try {
      const [users] = await db.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }

      const isValid = await verifyPassword(current_password, users[0].password_hash);
      if (!isValid) {
        return { error: 'Current password is incorrect', status: 401 };
      }

      const newHash = await hashPassword(new_password);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

      return { message: 'Password updated successfully' };
    } catch (error) {
      console.error('Password change error:', error);
      return { error: 'Failed to change password', status: 500 };
    }
  },

  'PUT /api/auth/profile': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { full_name } = body;
    if (full_name === undefined || full_name === null) {
      return { error: 'Full name is required', status: 400 };
    }

    try {
      await db.execute('UPDATE users SET full_name = ? WHERE id = ?', [full_name.trim() || null, userId]);
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role FROM users WHERE id = ?',
        [userId]
      );
      return { user: users[0] };
    } catch (error) {
      console.error('Profile update error:', error);
      return { error: 'Failed to update profile', status: 500 };
    }
  },
  
  // Stats endpoint
  'GET /api/stats': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?',
        [userId]
      );
      const [events] = await db.execute(
        'SELECT COUNT(*) as count FROM calendar_events WHERE user_id = ? AND start_time >= UTC_TIMESTAMP()',
        [userId]
      );
      const [unread] = await db.execute(
        'SELECT COUNT(*) as count FROM emails WHERE user_id = ? AND is_read = FALSE',
        [userId]
      );
      
      return {
        contacts: contacts[0].count,
        upcomingEvents: events[0].count,
        unreadEmails: unread[0].count,
      };
    } catch (error) {
      return { error: 'Failed to get stats', status: 500 };
    }
  },
  
  // Contacts endpoints
  'GET /api/contacts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT * FROM contacts WHERE user_id = ? ORDER BY is_favorite DESC, first_name ASC',
        [userId]
      );
      return { contacts };
    } catch (error) {
      return { error: 'Failed to get contacts', status: 500 };
    }
  },
  
  'POST /api/contacts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, phone, company, job_title, notes } = body;
    if (!first_name || !first_name.trim()) {
      return { error: 'First name is required', status: 400 };
    }

    try {
      const contactId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO contacts (id, user_id, first_name, last_name, email, phone, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [contactId, userId, first_name.trim(), last_name || null, email || null, phone || null, company || null, job_title || null, notes || null]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ?', [contactId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to create contact', status: 500 };
    }
  },
  
  'PUT /api/contacts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, phone, company, job_title, notes } = body;
    if (!first_name || !first_name.trim()) {
      return { error: 'First name is required', status: 400 };
    }

    try {
      const id = req.url.split('/').pop();
      
      await db.execute(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [first_name.trim(), last_name || null, email || null, phone || null, company || null, job_title || null, notes || null, id, userId]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to update contact', status: 500 };
    }
  },
  
  'DELETE /api/contacts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Contact deleted' };
    } catch (error) {
      return { error: 'Failed to delete contact', status: 500 };
    }
  },
  
  'GET /api/contacts/export': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [contacts] = await db.execute(
        'SELECT * FROM contacts WHERE user_id = ? ORDER BY first_name ASC',
        [userId]
      );

      if (contacts.length === 0) {
        return { error: 'No contacts to export', status: 404 };
      }

      const vcf = contacts.map(contactToVCard).join('\r\n');
      return { __raw: vcf, __contentType: 'text/vcard', __filename: 'contacts.vcf' };
    } catch (error) {
      console.error('Export error:', error);
      return { error: 'Failed to export contacts', status: 500 };
    }
  },

  'POST /api/contacts/import': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { vcf_data } = body;
    if (!vcf_data || typeof vcf_data !== 'string') {
      return { error: 'Missing vcf_data field', status: 400 };
    }

    try {
      const parsed = parseVCards(vcf_data);

      if (parsed.length === 0) {
        return { error: 'No valid contacts found in the file. Make sure it is a .vcf (vCard) file.', status: 400 };
      }

      let imported = 0;
      const errors = [];

      for (const c of parsed) {
        try {
          const contactId = crypto.randomUUID();
          await db.execute(
            'INSERT INTO contacts (id, user_id, first_name, last_name, email, phone, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [contactId, userId, c.first_name, c.last_name, c.email, c.phone, c.company, c.job_title, c.notes]
          );
          imported++;
        } catch (err) {
          const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
          errors.push(`Failed to import "${name}": ${err.message}`);
        }
      }

      return {
        message: `Imported ${imported} of ${parsed.length} contacts`,
        imported,
        total: parsed.length,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      console.error('Import error:', error);
      return { error: 'Failed to import contacts', status: 500 };
    }
  },

  'PUT /api/contacts/:id/favorite': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_favorite } = body;
      await db.execute(
        'UPDATE contacts SET is_favorite = ? WHERE id = ? AND user_id = ?',
        [is_favorite ? 1 : 0, id, userId]
      );
      return { message: 'Favorite status updated' };
    } catch (error) {
      return { error: 'Failed to update favorite', status: 500 };
    }
  },
  
  // Calendar events endpoints
  'GET /api/calendar/events': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [rows] = await db.execute(
        'SELECT * FROM calendar_events WHERE user_id = ? ORDER BY start_time ASC',
        [userId]
      );
      // Serialise dates as UTC ISO strings so the client gets correct times
      const events = rows.map((row) => ({
        ...row,
        start_time: row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
        end_time: row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time,
      }));
      return { events };
    } catch (error) {
      return { error: 'Failed to get events', status: 500 };
    }
  },
  
  'POST /api/calendar/events': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };

    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes } = body;
      // Normalise to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS)
      const toMysqlDatetime = (v) => {
        if (v == null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
      };
      const start = toMysqlDatetime(start_time);
      const end = toMysqlDatetime(end_time);
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };

      const eventId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_events (id, user_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eventId, userId, title.trim(), description || null, start, end, !!all_day, location?.trim() || null, color || '#22c55e', recurrence || null, reminder_minutes ?? null]
      );

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ?', [eventId]);
      return { event: events[0] };
    } catch (error) {
      console.error('Create event error:', error);
      return { error: error.message || 'Failed to create event', status: 500 };
    }
  },
  
  'PUT /api/calendar/events/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.url.split('/').pop();
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes } = body;
      const toMysqlDatetime = (v) => {
        if (v == null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
      };
      const start = toMysqlDatetime(start_time);
      const end = toMysqlDatetime(end_time);
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };

      await db.execute(
        'UPDATE calendar_events SET title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?, location = ?, color = ?, recurrence = ?, reminder_minutes = ? WHERE id = ? AND user_id = ?',
        [title?.trim() ?? '', description || null, start, end, !!all_day, location?.trim() || null, color || '#22c55e', recurrence || null, reminder_minutes ?? null, id, userId]
      );

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { event: events[0] };
    } catch (error) {
      console.error('Update event error:', error);
      return { error: error.message || 'Failed to update event', status: 500 };
    }
  },
  
  'DELETE /api/calendar/events/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Event deleted' };
    } catch (error) {
      return { error: 'Failed to delete event', status: 500 };
    }
  },
  
  // Mail accounts endpoints
  'GET /api/mail/accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [accounts] = await db.execute(
        'SELECT id, user_id, email_address, display_name, provider, is_active, last_synced_at, created_at FROM mail_accounts WHERE user_id = ?',
        [userId]
      );
      return { accounts };
    } catch (error) {
      return { error: 'Failed to get mail accounts', status: 500 };
    }
  },
  
  'POST /api/mail/accounts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password } = body;
      const accountId = crypto.randomUUID();
      const actualUsername = username || email_address; // fallback to email if no username
      await db.execute(
        'INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [accountId, userId, email_address, display_name || null, provider, actualUsername, imap_host || null, imap_port || 993, smtp_host || null, smtp_port || 587, encrypted_password ? encrypt(encrypted_password) : null]
      );
      
      const [accounts] = await db.execute('SELECT id, user_id, email_address, display_name, provider, is_active FROM mail_accounts WHERE id = ?', [accountId]);
      
      // Trigger initial sync
      syncMailAccount(accountId).catch(err => console.error('Initial sync failed:', err));
      
      return { account: accounts[0] };
    } catch (error) {
      console.error('Create mail account error:', error);
      return { error: error.message || 'Failed to create mail account', status: 500 };
    }
  },
  
  'DELETE /api/mail/accounts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Mail account deleted' };
    } catch (error) {
      return { error: 'Failed to delete mail account', status: 500 };
    }
  },
  
  // Emails endpoints
  'GET /api/mail/emails': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const folder = url.searchParams.get('folder') || 'inbox';
      const accountId = url.searchParams.get('account_id');
      
      let query = 'SELECT * FROM emails WHERE user_id = ?';
      const params = [userId];
      
      if (folder) {
        query += ' AND folder = ?';
        params.push(folder);
      }
      
      if (accountId) {
        query += ' AND mail_account_id = ?';
        params.push(accountId);
      }
      
      query += ' ORDER BY received_at DESC LIMIT 100';
      
      const [emails] = await db.execute(query, params);
      return { emails };
    } catch (error) {
      return { error: 'Failed to get emails', status: 500 };
    }
  },
  
  'PUT /api/mail/emails/:id/read': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_read } = body;
      await db.execute(
        'UPDATE emails SET is_read = ? WHERE id = ? AND user_id = ?',
        [is_read ? 1 : 0, id, userId]
      );
      return { message: 'Email read status updated' };
    } catch (error) {
      return { error: 'Failed to update email', status: 500 };
    }
  },
  
  'PUT /api/mail/emails/:id/star': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_starred } = body;
      await db.execute(
        'UPDATE emails SET is_starred = ? WHERE id = ? AND user_id = ?',
        [is_starred ? 1 : 0, id, userId]
      );
      return { message: 'Email star status updated' };
    } catch (error) {
      return { error: 'Failed to update email', status: 500 };
    }
  },
  
  'POST /api/mail/sync': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { account_id } = body;
      if (!account_id) return { error: 'Account ID required', status: 400 };
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      
      // Sync in background
      syncMailAccount(account_id).catch(err => console.error('Sync error:', err));
      
      return { message: 'Sync started' };
    } catch (error) {
      return { error: 'Failed to sync mail', status: 500 };
    }
  },
  
  'POST /api/mail/send': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { account_id, to, subject, body: emailBody, isHtml } = body;
      if (!account_id || !to || !subject || !emailBody) {
        return { error: 'Missing required fields', status: 400 };
      }
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      
      const result = await sendEmail(account_id, { to, subject, body: emailBody, isHtml });
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Send email error:', error);
      return { error: error.message || 'Failed to send email', status: 500 };
    }
  },

  // ── Admin endpoints (require admin role) ────────────────────────
  'GET /api/admin/users': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at DESC'
      );
      return { users };
    } catch (error) {
      return { error: 'Failed to get users', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/password': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const targetId = parts[parts.length - 2];
    const { new_password } = body;

    if (!new_password || new_password.length < 6) {
      return { error: 'New password must be at least 6 characters', status: 400 };
    }

    try {
      const newHash = await hashPassword(new_password);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, targetId]);
      // Invalidate all sessions so the user must re-login
      await db.execute('DELETE FROM sessions WHERE user_id = ?', [targetId]);
      return { message: 'Password updated successfully' };
    } catch (error) {
      return { error: 'Failed to update password', status: 500 };
    }
  },

  'DELETE /api/admin/users/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const id = req.url.split('?')[0].split('/').pop();

    if (id === userId) {
      return { error: 'Cannot delete your own account', status: 400 };
    }

    try {
      await db.execute('DELETE FROM users WHERE id = ?', [id]);
      return { message: 'User deleted' };
    } catch (error) {
      return { error: 'Failed to delete user', status: 500 };
    }
  },
};

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let routeKey = `${req.method} ${url.pathname}`;
  
  // Handle parameterized routes
  if (routeKey.includes('/api/contacts/') && req.method !== 'GET' && req.method !== 'POST') {
    routeKey = `${req.method} /api/contacts/:id`;
    if (url.pathname.includes('/favorite')) {
      routeKey = `${req.method} /api/contacts/:id/favorite`;
    }
  } else if (routeKey.includes('/api/calendar/events/')) {
    routeKey = `${req.method} /api/calendar/events/:id`;
  } else if (routeKey.includes('/api/mail/accounts/')) {
    routeKey = `${req.method} /api/mail/accounts/:id`;
  } else if (routeKey.includes('/api/mail/emails/')) {
    if (url.pathname.includes('/read')) {
      routeKey = `${req.method} /api/mail/emails/:id/read`;
    } else if (url.pathname.includes('/star')) {
      routeKey = `${req.method} /api/mail/emails/:id/star`;
    }
  } else if (routeKey.includes('/api/admin/users/')) {
    if (url.pathname.includes('/password')) {
      routeKey = `${req.method} /api/admin/users/:id/password`;
    } else {
      routeKey = `${req.method} /api/admin/users/:id`;
    }
  }
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const handler = routes[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }
  
  try {
    const userId = await verifyToken(req.headers.authorization);

    // Allow larger bodies for vCard import
    const maxBodySize = routeKey === 'POST /api/contacts/import' ? 500000 : 1000;
    const body = await parseBody(req, maxBodySize);

    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} characters)` }));
      return;
    }

    const result = await handler(req, userId, body);

    // Raw response (used by vCard export)
    if (result.__raw) {
      res.writeHead(200, {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${result.__filename || 'download'}"`,
      });
      res.end(result.__raw);
      return;
    }
    
    const status = result.status || 200;
    delete result.status;
    
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('Request error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

// Start server
async function start() {
  await initDatabase();
  
  const server = http.createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
  });
  
  // Periodic mail sync every 10 minutes
  setInterval(async () => {
    try {
      const [accounts] = await db.execute(
        'SELECT id, email_address FROM mail_accounts WHERE is_active = TRUE'
      );
      console.log(`\n[${new Date().toISOString()}] Starting periodic mail sync for ${accounts.length} accounts...`);
      for (const account of accounts) {
        syncMailAccount(account.id).catch(err => 
          console.error(`Failed to sync ${account.email_address}:`, err.message)
        );
      }
    } catch (error) {
      console.error('Periodic sync error:', error);
    }
  }, 10 * 60 * 1000); // 10 minutes
  
  console.log('✓ Periodic mail sync enabled (every 10 minutes)');
}

start();
