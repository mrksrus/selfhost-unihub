import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { RouteRequest } from '../types';

import crypto from 'node:crypto';

// The WebSocket subset a call's sound needs (RFC 6455), at the trust
// boundary: binary messages of at most `maxMessage` bytes, unfragmented, no
// extensions or subprotocols; ping, pong and close. Node has a WebSocket
// client only. Every frame a client sends is masked; a declared length over
// the limit is refused before its payload is buffered.

/** What the server's 'upgrade' event hands the request (request-handler.ts). */
interface UpgradeRequest extends RouteRequest { upgrade?: { socket: Socket; head: Buffer } }

interface WebSocketConnection {
  send(data: Buffer): void;
  ping(): void;
  close(code: number): void;
  /** Bytes written and not yet taken by the kernel. */
  readonly buffered: number;
  /** When the client last sent a frame of any kind. */
  readonly heardAt: number;
  readonly closed: boolean;
  onMessage: (data: Buffer) => void;
  onClose: () => void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Answers the handshake with 101, carrying the headers the boundary set on
 * `res` (the renewed session cookie, the request id); null when the request
 * is not a valid WebSocket handshake. The route's checks come before this.
 */
function acceptWebSocket(req: UpgradeRequest, res: ServerResponse, { maxMessage = 1024 } = {}): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (!req.upgrade || req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket'
    || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  const { socket, head } = req.upgrade;
  const headers = Object.entries(res.getHeaders()).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`));
  res.detachSocket(socket);
  socket.setNoDelay(true);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${
    crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n${headers.join('')}\r\n`);

  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;
  let heardAt = Date.now();
  const frame = (opcode: number, payload: Buffer) => {
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
    socket.write(Buffer.concat([header, payload]));
  };
  const connection: WebSocketConnection = {
    send: data => { if (!closed) frame(0x2, data); },
    ping: () => { if (!closed) frame(0x9, Buffer.alloc(0)); },
    close(code) {
      if (closed) return;
      closed = true;
      socket.end(Buffer.from([0x88, 2, code >> 8, code & 0xff]));
      // A client that never closes its side is not waited for.
      setTimeout(() => socket.destroy(), 1000).unref();
      connection.onClose();
    },
    get buffered() { return socket.writableLength; },
    get heardAt() { return heardAt; },
    get closed() { return closed; },
    onMessage: () => {},
    onClose: () => {},
  };

  function read(chunk: Buffer) {
    if (closed) return;
    heardAt = Date.now();
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (!closed && buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const control = opcode >= 0x8;
      if (buffer[0] & 0x70 || !(buffer[1] & 0x80) || ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) return connection.close(1002);
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (control && (length > 125 || !fin)) return connection.close(1002);
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        // Anything past 32 bits is over the limit anyway.
        length = buffer.readUInt32BE(2) ? Infinity : buffer.readUInt32BE(6);
        offset = 10;
      }
      if (opcode === 0x0 || opcode === 0x1 || !fin) return connection.close(1003);
      if (length > maxMessage) return connection.close(1009);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) return connection.close(1000);
      if (opcode === 0x9) frame(0xa, payload);
      else if (opcode === 0x2) connection.onMessage(payload);
    }
  }
  const gone = () => {
    if (!closed) { closed = true; connection.onClose(); }
    socket.destroy();
  };
  socket.on('data', read);
  socket.on('end', gone);
  socket.on('close', gone);
  socket.on('error', gone);
  if (head.length) queueMicrotask(() => read(head));
  return connection;
}

export { acceptWebSocket };
export type { UpgradeRequest, WebSocketConnection };
