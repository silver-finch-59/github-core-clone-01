// MCP surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Two protocol eras, one stateless handler (the suite accepts both):
//   modern  2026-07-28: every request declares its revision in `_meta` and in
//           the MCP-Protocol-Version header; `server/discover` answers the
//           server identity, capabilities and supportedVersions in one call.
//           No handshake, no session.
//   legacy  2025-11-25 and earlier: `initialize` + `notifications/initialized`,
//           with an optional Mcp-Session-Id header echoed back when present.
//
// Tools act on the same Store as the REST surface, so a repository, issue or
// pull request created over MCP reads back over /api/v3 as the same object
// with the same id. Nothing here reads the wall clock or randomness: every
// timestamp comes from store.nowIso() and every ordering from store.seq() /
// the store's own counters. No per-request mutable state is shared between
// concurrent calls: each request is answered from its own parsed body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BadJsonError,
  checkAuth,
  isRecord,
  pathOf,
  readJsonBody,
  sendJson,
  sendUnauthorized,
} from './http.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- constants

/** The server's identity, as `initialize` and `server/discover` report it. */
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** The current revision; also the first entry of `supportedVersions`. */
const PREFERRED_REVISION = '2026-07-28';

/** Every revision this server negotiates (current first, then the handshake era). */
const SUPPORTED_REVISIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const CAPABILITIES: Readonly<Record<string, unknown>> = Object.freeze({
  tools: {},
});

/** The JSON-RPC error codes this surface answers with. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------- tool list
//
// Built ONCE at module load and reused for every tools/list answer, so two
// calls answer the same list byte for byte. The objects are never mutated
// after construction (handlers only read them).

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_PROP: Record<string, unknown> = { type: 'string', description: 'Repository owner login' };
const REPO_PROP: Record<string, unknown> = { type: 'string', description: 'Repository name' };
const FULL_NAME_PROP: Record<string, unknown> = {
  type: 'string',
  description: 'Repository full name as "owner/repo" (alternative to owner + repo)',
};

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    { owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_NAME_PROP },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository, newest first.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      state: { type: 'string', description: 'Issue state filter: open, closed, or all', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name (the branch with the changes)' },
      base: { type: 'string', description: 'Base branch name (the branch the changes go into)' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge an open pull request into its base branch.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'get_issue',
    'Get one issue in a repository by number.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      issue_number: { type: 'integer', description: 'Issue number' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'list_pull_requests',
    'List pull requests in a repository, newest first.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      state: { type: 'string', description: 'Pull request state filter: open, closed, or all', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
]);

// ---------------------------------------------------------------- argument mapping
//
// The suite maps its documented argument names onto the schema's nearest
// property, but direct callers may use any documented spelling, so the
// handler resolves arguments by normalized name across every alias list in
// the suite spec (checks-mcp.ts ARGUMENT_SYNONYMS) plus the full_name form.

/** Normalize an argument key: lowercase, every non-alphanumeric removed. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ARG_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  owner: Object.freeze(['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']),
  repo: Object.freeze(['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']),
  full_name: Object.freeze(['full_name', 'repo_full_name', 'repository_full_name', 'fullName']),
  title: Object.freeze(['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']),
  body: Object.freeze(['body', 'issue_body', 'description', 'content', 'text', 'comment']),
  head: Object.freeze(['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']),
  base: Object.freeze(['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']),
  pull_number: Object.freeze(['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']),
  issue_number: Object.freeze(['issue_number', 'number', 'pull_number', 'pull_request_number', 'pr_number', 'index']),
  name: Object.freeze(['name', 'repo', 'repository', 'repository_name', 'repo_name']),
  description: Object.freeze(['description', 'about', 'summary', 'body']),
  private: Object.freeze(['private', 'is_private']),
  state: Object.freeze(['state', 'status']),
});

/** First defined value among `keys` (matched by normalized name), else undefined. */
function argValue(args: Record<string, unknown>, keys: readonly string[]): unknown {
  const byNormalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(args)) {
    const normalized = normalizeKey(key);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, value);
  }
  for (const key of keys) {
    const value = byNormalized.get(normalizeKey(key));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The argument as a non-empty string, or null when absent / not a string. */
function argString(args: Record<string, unknown>, semantic: string): string | null {
  const value = argValue(args, ARG_ALIASES[semantic] ?? [semantic]);
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

/** The argument as an integer (numbers, or digit strings), or null. */
function argInt(args: Record<string, unknown>, semantic: string): number | null {
  const value = argValue(args, ARG_ALIASES[semantic] ?? [semantic]);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Resolve owner + repo from the arguments, via owner/repo or full_name ("owner/repo"). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = argString(args, 'owner');
  let repo = argString(args, 'repo');
  if (owner !== null && repo !== null && repo.includes('/')) {
    // A repo value carrying the full name wins over a separate owner.
    const [head, ...rest] = repo.split('/');
    if (head !== '' && rest.length > 0) {
      owner = head;
      repo = rest.join('/');
    }
  }
  if ((owner === null || repo === null) && (owner !== null || repo !== null)) {
    // One half given: the other half may hide in full_name.
    const fullName = argString(args, 'full_name');
    if (fullName !== null && fullName.includes('/')) {
      const [fullOwner, ...rest] = fullName.split('/');
      if (fullOwner !== '' && rest.length > 0) {
        if (owner === null) owner = fullOwner;
        if (repo === null) repo = rest.join('/');
      }
    }
  }
  if (owner === null || repo === null) {
    const fullName = argString(args, 'full_name');
    if (fullName !== null && fullName.includes('/')) {
      const [fullOwner, ...rest] = fullName.split('/');
      if (fullOwner !== '' && rest.length > 0) return { owner: fullOwner, repo: rest.join('/') };
    }
    return null;
  }
  return { owner, repo };
}

// ---------------------------------------------------------------- REST-shaped views
//
// The same Store objects the REST surface serializes, in api.github.com
// field names (snake_case). Ids come from the store, so MCP and REST agree.

function userView(store: Store, login: string): Record<string, unknown> {
  const id = login === store.viewer.login ? store.viewer.id : login === store.teammate.login ? store.teammate.id : login === store.stranger.login ? store.stranger.id : 0;
  return { login, id, type: 'User' };
}

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userView(store, repo.owner),
    description: repo.description,
    private: repo.private,
    fork: repo.fork,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `https://example.invalid/api/v3/repos/${repo.fullName}`,
  };
}

function issueView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
    user: userView(store, issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `https://example.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullView(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const refView = (ref: { ref: string; sha: string; repo: string }): Record<string, unknown> => ({
    ref: ref.ref,
    sha: ref.sha,
    label: `${ref.repo.split('/')[0] ?? ''}:${ref.ref}`,
    repo: { full_name: ref.repo },
  });
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    draft: pull.draft,
    head: refView(pull.head),
    base: refView(pull.base),
    user: userView(store, pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `https://example.invalid/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- tool results

/** A successful tool result: the object as JSON text, plus structured content. */
function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A failed tool execution: isError with a JSON message body. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ message }) }],
    isError: true,
  };
}

/** Missing required arguments, named in the error text. */
function missingArgs(missing: string[]): Record<string, unknown> {
  return toolError(`Missing required argument(s): ${missing.join(', ')}`);
}

// ---------------------------------------------------------------- tool implementations

function findRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: Record<string, unknown> } {
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) return { error: missingArgs(['owner', 'repo']) };
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (repo === undefined) return { error: toolError(`Not Found: repository ${resolved.owner}/${resolved.repo} does not exist`) };
  return { repo };
}

function callCreateRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const name = argString(args, 'name');
  if (name === null) return missingArgs(['name']);
  const description = argString(args, 'description');
  const existing = store.getRepo(store.viewer.login, name);
  if (existing !== undefined) return toolOk(repoView(store, existing));
  const repo = store.createRepo(name, description);
  return toolOk(repoView(store, repo));
}

function callGetRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const found = findRepo(store, args);
  if ('error' in found) return found.error;
  return toolOk(repoView(store, found.repo));
}

function callCreateIssue(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const title = argString(args, 'title');
  const missing: string[] = [];
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) missing.push('owner', 'repo');
  if (title === null) missing.push('title');
  if (missing.length > 0) return missingArgs(missing);
  const repo = store.getRepo((resolved as { owner: string; repo: string }).owner, (resolved as { owner: string; repo: string }).repo);
  if (repo === undefined) {
    return toolError(`Not Found: repository ${(resolved as { owner: string; repo: string }).owner}/${(resolved as { owner: string; repo: string }).repo} does not exist`);
  }
  const body = argString(args, 'body');
  const now = store.nowIso();
  const issue: Issue = {
    id: store.nextObjectId(),
    number: repo.issueSeq + 1,
    title: title as string,
    body: body,
    state: 'open',
    labels: [],
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: 0,
  };
  repo.issueSeq += 1;
  repo.issues.push(issue);
  repo.updatedAt = now;
  return toolOk(issueView(store, repo, issue));
}

function callListIssues(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const found = findRepo(store, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const state = argString(args, 'state') ?? 'open';
  const filtered = repo.issues
    .filter((issue) => state === 'all' || issue.state === state)
    .slice()
    .sort((a, b) => b.number - a.number);
  return toolOk(filtered.map((issue) => issueView(store, repo, issue)));
}

function callGetIssue(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const found = findRepo(store, args);
  if ('error' in found) return found.error;
  const number = argInt(args, 'issue_number');
  if (number === null) return missingArgs(['issue_number']);
  const issue = found.repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return toolError(`Not Found: issue #${number} does not exist`);
  return toolOk(issueView(store, found.repo, issue));
}

function callCreatePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const title = argString(args, 'title');
  const head = argString(args, 'head');
  const base = argString(args, 'base');
  const missing: string[] = [];
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) missing.push('owner', 'repo');
  if (title === null) missing.push('title');
  if (head === null) missing.push('head');
  if (base === null) missing.push('base');
  if (missing.length > 0) return missingArgs(missing);
  const owner = (resolved as { owner: string; repo: string }).owner;
  const name = (resolved as { owner: string; repo: string }).repo;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${name} does not exist`);
  const body = argString(args, 'body');
  const now = store.nowIso();
  const headSha = store.resolveRef(repo, head as string) ?? '';
  const baseSha = store.resolveRef(repo, base as string) ?? '';
  const pull: Pull = {
    id: store.nextObjectId(),
    number: repo.pullSeq + 1,
    title: title as string,
    body: body,
    state: 'open',
    merged: false,
    draft: false,
    head: { ref: head as string, sha: headSha, repo: repo.fullName },
    base: { ref: base as string, sha: baseSha, repo: repo.fullName },
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
  };
  repo.pullSeq += 1;
  repo.pulls.push(pull);
  repo.updatedAt = now;
  return toolOk(pullView(store, repo, pull));
}

function callListPullRequests(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const found = findRepo(store, args);
  if ('error' in found) return found.error;
  const repo = found.repo;
  const state = argString(args, 'state') ?? 'open';
  const filtered = repo.pulls
    .filter((pull) => state === 'all' || pull.state === state)
    .slice()
    .sort((a, b) => b.number - a.number);
  return toolOk(filtered.map((pull) => pullView(store, repo, pull)));
}

function callMergePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const number = argInt(args, 'pull_number');
  const missing: string[] = [];
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) missing.push('owner', 'repo');
  if (number === null) missing.push('pull_number');
  if (missing.length > 0) return missingArgs(missing);
  const owner = (resolved as { owner: string; repo: string }).owner;
  const name = (resolved as { owner: string; repo: string }).repo;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${name} does not exist`);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return toolError(`Not Found: pull request #${number} does not exist`);
  if (pull.merged) return toolOk(pullView(store, repo, pull));
  // Land the head branch's tree on the default branch as one squash commit,
  // parented on the base branch's commit — the same shape the REST merge
  // produces, so clones and GET /commits see the merged tree.
  let mergeSha: string | null = null;
  const headSha = store.resolveRef(repo, pull.head.ref);
  const baseSha = store.resolveRef(repo, pull.base.ref);
  if (headSha !== undefined && baseSha !== undefined) {
    const headObj = store.getObject(repo, headSha);
    if (headObj !== undefined && headObj.type === 'commit') {
      const { tree } = store.parseCommit(headObj.content);
      mergeSha = store.commitTree(repo, tree, [baseSha], `Merge pull request #${pull.number} from ${pull.head.repo}:${pull.head.ref}`);
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, mergeSha);
    }
  }
  if (mergeSha === null) mergeSha = headSha ?? null;
  const now = store.nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = now;
  repo.updatedAt = now;
  return toolOk(pullView(store, repo, pull));
}

/** Dispatch one tools/call by (suffix-matched, case-insensitive) tool name. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: JsonRpcError } {
  const normalized = normalizeKey(name);
  const match = (canonical: string): boolean => normalized === canonical || normalized.endsWith(canonical);
  if (match('createrepo')) return { result: callCreateRepo(store, args) };
  if (match('getrepo')) return { result: callGetRepo(store, args) };
  if (match('createissue')) return { result: callCreateIssue(store, args) };
  if (match('listissues')) return { result: callListIssues(store, args) };
  if (match('createpullrequest')) return { result: callCreatePullRequest(store, args) };
  if (match('mergepullrequest')) return { result: callMergePullRequest(store, args) };
  if (match('getissue')) return { result: callGetIssue(store, args) };
  if (match('listpullrequests')) return { result: callListPullRequests(store, args) };
  return { error: { code: METHOD_NOT_FOUND, message: `Method not found: tool ${name}` } };
}

// ---------------------------------------------------------------- JSON-RPC plumbing

/** Extra headers for a JSON answer: echo the session id when one arrived. */
function responseHeaders(req: IncomingMessage, revision: string): Record<string, string> {
  const headers: Record<string, string> = { 'mcp-protocol-version': revision };
  const session = req.headers['mcp-session-id'];
  if (typeof session === 'string' && session !== '') headers['mcp-session-id'] = session;
  return headers;
}

function sendResult(res: ServerResponse, req: IncomingMessage, revision: string, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, responseHeaders(req, revision));
}

function sendError(res: ServerResponse, req: IncomingMessage, revision: string, status: number, id: JsonRpcId | null, error: JsonRpcError): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error }, responseHeaders(req, revision));
}

/** A notification answer: HTTP 202 with an empty body, no JSON-RPC frame. */
function sendNotificationAck(res: ServerResponse, req: IncomingMessage, revision: string): void {
  const headers: Record<string, string> = { 'mcp-protocol-version': revision };
  const session = req.headers['mcp-session-id'];
  if (typeof session === 'string' && session !== '') headers['mcp-session-id'] = session;
  res.writeHead(202, { ...headers, 'content-length': '0' });
  res.end();
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Negotiate an initialize revision: echo a supported one, else -32602. */
function negotiateRevision(requested: unknown): string | null {
  if (typeof requested !== 'string') return PREFERRED_REVISION;
  return (SUPPORTED_REVISIONS as readonly string[]).includes(requested) ? requested : null;
}

// ---------------------------------------------------------------- handler

/**
 * Answer POST /mcp. Returns true when the request was answered here.
 * Auth runs before parsing: no (or wrong) Bearer token -> 401. A body that
 * is not JSON -> HTTP 400 with JSON-RPC -32700. Unknown methods and tools
 * answer JSON-RPC -32601, never HTTP 500.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (pathOf(req) !== '/mcp' || (req.method ?? '') !== 'POST') return false;

  // Authentication first: every MCP call needs the shop token.
  if (checkAuth(req, store) !== 'ok') {
    sendUnauthorized(res, true);
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BadJsonError) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }, responseHeaders(req, PREFERRED_REVISION));
      return true;
    }
    throw error;
  }

  // An empty body is not a JSON-RPC request.
  if (isRecord(body) && Object.keys(body).length === 0) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }, responseHeaders(req, PREFERRED_REVISION));
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } }, responseHeaders(req, PREFERRED_REVISION));
    return true;
  }

  const method = typeof body.method === 'string' ? body.method : '';
  const hasId = 'id' in body && body.id !== undefined;
  const id = (hasId ? body.id : null) as JsonRpcId | null;
  const params = isRecord(body.params) ? body.params : {};

  // The revision this request declares: the modern `_meta` spelling first,
  // then the plain `protocolVersion` key the suite also sends, then the
  // MCP-Protocol-Version header, else the preferred revision.
  const meta = isRecord(params._meta) ? params._meta : {};
  const declared =
    typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
      : typeof meta.protocolVersion === 'string'
        ? (meta.protocolVersion as string)
        : typeof req.headers['mcp-protocol-version'] === 'string'
          ? (req.headers['mcp-protocol-version'] as string)
          : PREFERRED_REVISION;
  const revision = (SUPPORTED_REVISIONS as readonly string[]).includes(declared) ? declared : PREFERRED_REVISION;

  // Notifications carry no id and get no JSON-RPC frame back: 202, empty body.
  if (!hasId) {
    sendNotificationAck(res, req, revision);
    return true;
  }

  if (method === '' || body.jsonrpc !== '2.0') {
    sendError(res, req, revision, 400, id, { code: INVALID_REQUEST, message: 'Invalid Request' });
    return true;
  }

  switch (method) {
    case 'server/discover': {
      sendResult(res, req, revision, id as JsonRpcId, {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_REVISIONS],
        capabilities: CAPABILITIES,
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
      return true;
    }
    case 'initialize': {
      const requested = params.protocolVersion;
      const negotiated = negotiateRevision(requested);
      if (negotiated === null) {
        sendError(res, req, revision, 200, id as JsonRpcId, {
          code: INVALID_PARAMS,
          message: `Unsupported protocol version: ${String(requested)}`,
          data: { supported: [...SUPPORTED_REVISIONS] },
        });
        return true;
      }
      sendResult(res, req, negotiated, id as JsonRpcId, {
        protocolVersion: negotiated,
        capabilities: CAPABILITIES,
        serverInfo: serverInfo(),
      });
      return true;
    }
    case 'ping': {
      sendResult(res, req, revision, id as JsonRpcId, {});
      return true;
    }
    case 'tools/list': {
      // The same module-level list every time: byte-identical answers.
      sendResult(res, req, revision, id as JsonRpcId, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (name === '') {
        sendError(res, req, revision, 200, id as JsonRpcId, { code: INVALID_PARAMS, message: 'Invalid params: tools/call requires a tool name' });
        return true;
      }
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callTool(store, name, args);
      if ('error' in outcome) {
        sendError(res, req, revision, 200, id as JsonRpcId, outcome.error);
        return true;
      }
      sendResult(res, req, revision, id as JsonRpcId, outcome.result);
      return true;
    }
    default: {
      // Includes notifications/* that (unusually) carry an id, and any other
      // method this server does not implement.
      if (method.startsWith('notifications/')) {
        sendResult(res, req, revision, id as JsonRpcId, {});
        return true;
      }
      sendError(res, req, revision, 200, id as JsonRpcId, { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
      return true;
    }
  }
}
