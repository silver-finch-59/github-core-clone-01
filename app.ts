// The forge's HTTP server: routing only. Each surface lives in its own
// module (lib/git.ts, lib/rest.ts, lib/graphql.ts, lib/mcp.ts) and answers
// for its own paths; this file decides which module a request belongs to and
// keeps the process alive through any handler error — a 500 JSON answer is
// always better than a crashed server, and the suite's boot budget is 20 s.
//
//   GET  /healthz                    200 {"ok":true}, no auth (boot probe)
//   /api/v3/*                        REST v3 (lib/rest.ts)
//   POST /api/graphql                GraphQL v4 (lib/graphql.ts)
//   POST /mcp                        MCP streamable HTTP (lib/mcp.ts)
//   /{owner}/{repo}.git/*            git smart HTTP (lib/git.ts)
//   anything else                    404 {"message": "Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathOf, sendJson } from './lib/http.ts';
import { Store } from './lib/store.ts';
import { handleGit } from './lib/git.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const handled = await route(req, res, store);
        if (!handled) {
          sendJson(res, 404, { message: 'Not Found' });
        }
      } catch (err) {
        // Never let one request kill the server: answer 500 JSON and stay up.
        try {
          process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
          if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
          else res.end();
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
}

/** Route one request to its surface. Returns true when answered. */
async function route(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/graphql' && method === 'POST') {
    return handleGraphql(req, res, store);
  }

  if (path === '/mcp' && method === 'POST') {
    return handleMcp(req, res, store);
  }

  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    return handleRest(req, res, store);
  }

  // /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack,
  // /{owner}/{repo}.git/git-receive-pack
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    return handleGit(req, res, store);
  }

  return false;
}
