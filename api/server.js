// UniHub API Server
// Backend API for self-hosted deployments

const http = require('http');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unihub-encryption-key-for-email-credentials-change-me';

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
  try {
    db = await mysql.createPool({
      uri: databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
    console.log('✓ Database connected');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    process.exit(1);
  }
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

// Parse JSON body (max 1000 characters)
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (body.length > 1000) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
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
  
  // Stats endpoint
  'GET /api/stats': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?',
        [userId]
      );
      const [events] = await db.execute(
        'SELECT COUNT(*) as count FROM calendar_events WHERE user_id = ? AND start_time >= NOW()',
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
    
    try {
      const { first_name, last_name, email, phone, company, job_title, notes } = body;
      const contactId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO contacts (id, user_id, first_name, last_name, email, phone, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [contactId, userId, first_name, last_name || null, email || null, phone || null, company || null, job_title || null, notes || null]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ?', [contactId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to create contact', status: 500 };
    }
  },
  
  'PUT /api/contacts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      const { first_name, last_name, email, phone, company, job_title, notes } = body;
      
      await db.execute(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [first_name, last_name || null, email || null, phone || null, company || null, job_title || null, notes || null, id, userId]
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
      const [events] = await db.execute(
        'SELECT * FROM calendar_events WHERE user_id = ? ORDER BY start_time ASC',
        [userId]
      );
      return { events };
    } catch (error) {
      return { error: 'Failed to get events', status: 500 };
    }
  },
  
  'POST /api/calendar/events': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes } = body;
      const eventId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_events (id, user_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eventId, userId, title, description || null, start_time, end_time, all_day || false, location || null, color || '#22c55e', recurrence || null, reminder_minutes || null]
      );
      
      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ?', [eventId]);
      return { event: events[0] };
    } catch (error) {
      return { error: 'Failed to create event', status: 500 };
    }
  },
  
  'PUT /api/calendar/events/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes } = body;
      
      await db.execute(
        'UPDATE calendar_events SET title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?, location = ?, color = ?, recurrence = ?, reminder_minutes = ? WHERE id = ? AND user_id = ?',
        [title, description || null, start_time, end_time, all_day || false, location || null, color || '#22c55e', recurrence || null, reminder_minutes || null, id, userId]
      );
      
      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { event: events[0] };
    } catch (error) {
      return { error: 'Failed to update event', status: 500 };
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
      const { email_address, display_name, provider, imap_host, imap_port, smtp_host, smtp_port, encrypted_password } = body;
      const accountId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, imap_host, imap_port, smtp_host, smtp_port, encrypted_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [accountId, userId, email_address, display_name || null, provider, imap_host || null, imap_port || 993, smtp_host || null, smtp_port || 587, encrypted_password || null]
      );
      
      const [accounts] = await db.execute('SELECT id, user_id, email_address, display_name, provider, is_active FROM mail_accounts WHERE id = ?', [accountId]);
      return { account: accounts[0] };
    } catch (error) {
      return { error: 'Failed to create mail account', status: 500 };
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
    const body = await parseBody(req);

    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large (max 1000 characters)' }));
      return;
    }

    const result = await handler(req, userId, body);
    
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
}

start();
