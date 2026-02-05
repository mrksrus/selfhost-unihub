// UniHub API Server
// Minimal backend for self-hosted deployments

const http = require('http');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;

// Database connection pool
let db;

async function initDatabase() {
  try {
    db = await mysql.createPool({
      uri: process.env.DATABASE_URL,
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

// Simple router
const routes = {
  'GET /health': async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  
  'GET /api/stats': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
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
  },
};

// Parse JSON body
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// JWT verification (simplified)
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const [, payload] = token.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp && data.exp < Date.now() / 1000) return null;
    return data.sub || data.userId;
  } catch {
    return null;
  }
}

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;
  
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
    const userId = verifyToken(req.headers.authorization);
    const body = await parseBody(req);
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
