// HTTP plumbing every surface shares: JSON answers, request ids, auth, body
// parsing. Nothing here reads the wall clock or randomness: request ids are a
// per-process counter, so two runs answer the same sequence of ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next deterministic request id: `req-` + 12 hex digits, zero padded. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(12, '0')}`;
}

/** Answer with a JSON body. `extraHeaders` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Answer with a raw buffer body (git smart HTTP). */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse. Never throws. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query params of a request URL, or empty when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token a request carries, or null when it carries none. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

export type AuthResult = 'ok' | 'missing' | 'wrong';

/** Check a request's bearer token against the store's token. */
export function checkAuth(req: IncomingMessage, store: Store): AuthResult {
  const token = bearerToken(req);
  if (token === null) return 'missing';
  return token === store.token ? 'ok' : 'wrong';
}

/** A 401 JSON answer for a failed auth check. */
export function sendUnauthorized(res: ServerResponse, requestId: boolean): void {
  const headers: Record<string, string> = {};
  if (requestId) headers['x-github-request-id'] = nextRequestId();
  sendJson(res, 401, { message: 'Requires authentication' }, headers);
}

/** A 404 JSON answer: {"message": "Not Found"}. */
export function sendNotFound(res: ServerResponse, requestId: boolean): void {
  const headers: Record<string, string> = {};
  if (requestId) headers['x-github-request-id'] = nextRequestId();
  sendJson(res, 404, { message: 'Not Found' }, headers);
}

/** A 400 JSON answer for a malformed JSON body. */
export function sendBadJson(res: ServerResponse, requestId: boolean): void {
  const headers: Record<string, string> = {};
  if (requestId) headers['x-github-request-id'] = nextRequestId();
  sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
}

export class BadJsonError extends Error {
  constructor() {
    super('malformed JSON body');
    this.name = 'BadJsonError';
  }
}

/** Read a request body fully, as a Buffer. Caps at 64 MiB. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Read and parse a JSON request body. An empty body counts as `{}`. A
 * malformed body throws BadJsonError. A non-object body (array, string,
 * number) is returned as-is; handlers decide whether to reject it.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new BadJsonError();
  }
}

/** True when `value` is a plain JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a path into its '/'-separated segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * A Link header for paginated lists. `base` is the request's ABSOLUTE URL
 * without query (origin + path): the suite's client rejects a relative next
 * URL, so a bare path is not enough. `page`/`perPage` the current page,
 * `total` the item count. Emits rel="next" and rel="last" only when there is
 * a next page.
 */
export function paginationLink(base: string, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const next = `${base}?page=${page + 1}&per_page=${perPage}`;
  const last = `${base}?page=${lastPage}&per_page=${perPage}`;
  return `<${next}>; rel="next", <${last}>; rel="last"`;
}

/** Parse `page`/`per_page` query params: page >= 1, per_page 1..100, default 30. */
export function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  return { page, perPage };
}

/** Slice a list to one page (newest-first lists are pre-sorted by the caller). */
export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
