// The API's one way to write a log line. Each line names its area (the
// "[AREA]" prefix of the text format) and may carry fields; a line written
// while a request is being handled also carries that request's id, which the
// response returns in X-Request-Id and in the body of a 500. So a person can
// report the id of a failed request and the log shows every line it wrote.
//
// LOG_FORMAT=json writes one JSON object per line for a log collector; the
// default is readable text for `docker logs`. Fields and messages must not
// carry message content, credentials or other private data.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;
type Sink = (level: Level, line: string) => void;

const requests = new AsyncLocalStorage<{ requestId: string }>();
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
let json = process.env.LOG_FORMAT === 'json';
let sink: Sink = (level, line) => (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(line);

function newRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Runs `work` as part of a request: every line it logs carries `requestId`. */
function withRequestId<T>(requestId: string, work: () => T) {
  return requests.run({ requestId: REQUEST_ID.test(requestId) ? requestId : newRequestId() }, work);
}

function currentRequestId() {
  return requests.getStore()?.requestId ?? null;
}

function errorFields(error: unknown) {
  if (!(error instanceof Error)) return error === undefined ? {} : { error: String(error) };
  const { code } = error as NodeJS.ErrnoException;
  return { error: error.message, ...(code ? { code } : {}), ...(error.stack ? { stack: error.stack } : {}) };
}

function text(value: unknown) {
  const plain = typeof value === 'string' ? value : JSON.stringify(value);
  return /^[^\s"=]+$/.test(plain ?? '') ? plain : JSON.stringify(plain);
}

function write(level: Level, area: string, message: string, fields: Fields = {}, error?: unknown) {
  const requestId = currentRequestId();
  const { stack, ...failure } = errorFields(error) as Fields & { stack?: string };
  const all: Fields = { ...fields, ...failure, ...(requestId ? { requestId } : {}) };
  if (json) {
    sink(level, JSON.stringify({ time: new Date().toISOString(), level, area, msg: message, ...all, ...(stack ? { stack } : {}) }));
    return;
  }
  const pairs = Object.entries(all).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${text(value)}`);
  sink(level, [`[${area}] ${message}`, ...pairs].join(' ') + (stack && level === 'error' ? `\n${stack}` : ''));
}

const log = {
  info: (area: string, message: string, fields?: Fields) => write('info', area, message, fields),
  warn: (area: string, message: string, fields?: Fields, error?: unknown) => write('warn', area, message, fields, error),
  error: (area: string, message: string, error?: unknown, fields?: Fields) => write('error', area, message, fields, error),
};

/** Tests only: capture lines and choose the format. Returns the restore function. */
function captureLog(next: Sink, format: 'text' | 'json' = 'text') {
  const previous = { sink, json };
  sink = next;
  json = format === 'json';
  return () => { sink = previous.sink; json = previous.json; };
}

export { log, newRequestId, withRequestId, currentRequestId, captureLog };
