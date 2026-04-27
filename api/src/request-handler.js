const routes = require('./routes');
const { verifyToken, validateCsrfToken } = require('./auth');
const { parseBody, getAllowedOriginForRequest } = require('./http/request');

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let routeKey = `${req.method} ${url.pathname}`;
  req.params = {};
  
  // Handle parameterized routes
  if (routeKey.includes('/api/contacts/') && req.method !== 'GET' && req.method !== 'POST') {
    routeKey = `${req.method} /api/contacts/:id`;
    if (url.pathname.includes('/favorite')) {
      routeKey = `${req.method} /api/contacts/:id/favorite`;
    }
  } else if (routeKey.includes('/api/calendar/accounts/')) {
    if (url.pathname.endsWith('/sync')) {
      routeKey = `${req.method} /api/calendar/accounts/:id/sync`;
    } else {
      routeKey = `${req.method} /api/calendar/accounts/:id`;
    }
  } else if (routeKey.includes('/api/calendar/calendars/')) {
    routeKey = `${req.method} /api/calendar/calendars/:id`;
  } else if (routeKey.includes('/api/calendar/events/')) {
    if (url.pathname.includes('/todo-status')) {
      routeKey = `${req.method} /api/calendar/events/:id/todo-status`;
    } else if (url.pathname.includes('/rsvp')) {
      routeKey = `${req.method} /api/calendar/events/:id/rsvp`;
    } else if (url.pathname.includes('/subtasks/reorder')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks/reorder`;
    } else if (url.pathname.endsWith('/subtasks')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks`;
    } else if (url.pathname.includes('/subtasks/')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks/:subtaskId`;
    } else {
      routeKey = `${req.method} /api/calendar/events/:id`;
    }
  } else if (routeKey.includes('/api/mail/sender-rules/') && !url.pathname.endsWith('/backfill')) {
    const parts = url.pathname.split('/').filter(Boolean);
    req.params.id = parts[parts.length - 1] || null;
    routeKey = `${req.method} /api/mail/sender-rules/:id`;
  } else if (routeKey.includes('/api/mail/folders/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    req.params.slug = parts[parts.length - 1] || null;
    routeKey = `${req.method} /api/mail/folders/:slug`;
  } else if (routeKey.includes('/api/mail/accounts/')) {
    routeKey = `${req.method} /api/mail/accounts/:id`;
  } else if (routeKey.includes('/api/mail/attachments/')) {
    routeKey = `${req.method} /api/mail/attachments/:id`;
  } else if (routeKey.includes('/api/mail/emails/')) {
    if (url.pathname.includes('/bulk-delete')) {
      routeKey = `${req.method} /api/mail/emails/bulk-delete`;
    } else if (url.pathname.includes('/bulk-move')) {
      routeKey = `${req.method} /api/mail/emails/bulk-move`;
    } else if (url.pathname.includes('/bulk-update')) {
      routeKey = `${req.method} /api/mail/emails/bulk-update`;
    } else if (url.pathname.includes('/read')) {
      routeKey = `${req.method} /api/mail/emails/:id/read`;
    } else if (url.pathname.includes('/star')) {
      routeKey = `${req.method} /api/mail/emails/:id/star`;
    } else {
      // Handle GET /api/mail/emails/:id
      routeKey = `${req.method} /api/mail/emails/:id`;
    }
  } else if (routeKey.includes('/api/admin/users/')) {
    if (url.pathname.includes('/password')) {
      routeKey = `${req.method} /api/admin/users/:id/password`;
    } else if (url.pathname.includes('/activate')) {
      routeKey = `${req.method} /api/admin/users/:id/activate`;
    } else {
      routeKey = `${req.method} /api/admin/users/:id`;
    }
  }
  
  // CORS headers
  const allowedOrigin = getAllowedOriginForRequest(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
  
  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !allowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.headers.origin && !allowedOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }
  
  const handler = routes[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }
  
  try {
    const userId = await verifyToken(req);

    // Validate CSRF token for authenticated state-changing requests
    if (userId && !validateCsrfToken(req, res)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token validation failed', status: 403 }));
      return;
    }

    // Allow larger bodies for vCard import and bulk operations
    let maxBodySize = 1000; // Default for most endpoints
    if (routeKey === 'POST /api/contacts/import') {
      maxBodySize = 500000; // vCard import can be large
    } else if (routeKey === 'POST /api/backup/import') {
      maxBodySize = 150 * 1024 * 1024; // Backup archives can include attachments/raw email content.
    } else if (routeKey === 'POST /api/mail/send') {
      maxBodySize = 30 * 1024 * 1024; // Allow attachments in compose (base64 JSON payload)
    } else if (
      routeKey === 'POST /api/calendar/accounts' ||
      routeKey === 'PUT /api/calendar/accounts/:id' ||
      routeKey === 'POST /api/calendar/accounts/:id/sync'
    ) {
      maxBodySize = 50000; // OAuth tokens/provider config payloads
    } else if (
      routeKey === 'POST /api/mail/emails/bulk-update' ||
      routeKey === 'POST /api/mail/emails/bulk-delete' ||
      routeKey === 'POST /api/mail/emails/bulk-move' ||
      routeKey === 'POST /api/mail/sync'
    ) {
      maxBodySize = 50000; // Bulk operations and sync need more space (100 emails * ~36 chars UUID + JSON overhead)
    }
    const body = await parseBody(req, maxBodySize);

    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} characters)` }));
      return;
    }

    const result = await handler(req, userId, body, res);

    if (result.__redirect) {
      res.writeHead(302, { Location: result.__redirect });
      res.end();
      return;
    }

    if (Object.prototype.hasOwnProperty.call(result, '__html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.__html);
      return;
    }

    // Raw response (used by vCard export and attachments)
    if (result.__raw) {
      const filename = result.__filename || 'download';
      // Properly encode filename for Content-Disposition header (RFC 5987)
      const encodedFilename = encodeURIComponent(filename);
      const contentDisposition = `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
      
      res.writeHead(200, {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-cache',
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

module.exports = {
  handleRequest,
};
