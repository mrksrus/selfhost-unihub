// Loopback-only server for the built frontend. The page's /api requests are
// answered by the synthetic fixture router inside each test (support/test.ts);
// this server only holds the live-update stream open and refuses every other
// /api path, so a request the router missed can never reach a real backend.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { distDir } from './env.mts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
};

export interface FixtureServer { origin: string; close: () => Promise<void> }

export async function startServer(): Promise<FixtureServer> {
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`No frontend build at ${distDir}.`);
  const streams = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': synthetic live stream, no events\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(599, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `ui-regression: ${req.method} ${url.pathname} reached the loopback server without a fixture` }));
      return;
    }
    const file = path.normalize(path.join(distDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, file);
    // Client-side routes get the app shell, as Nginx does in production.
    if (!path.extname(url.pathname)) return send(res, index);
    res.writeHead(404).end();
  });

  function send(res: http.ServerResponse, file: string) {
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
