// REST v3 surface for the github-core-clone-01 forge (`/api/v3`).
//
// Implements the contract in DESIGN.md and checks-rest.ts: repos, branches,
// commits, contents, labels, issues (+ comments) and pull requests, plus the
// protocol rules (auth 401, JSON everywhere, X-GitHub-Request-Id on every
// reply, malformed JSON 400, unknown route 404 JSON). Node 22 stdlib only.
// No wall clock, no randomness: every timestamp comes from store.nowIso()
// and every ordering from creation counters (issue/pull numbers, repo ids).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BadJsonError,
  checkAuth,
  isRecord,
  JSON_TYPE,
  nextRequestId,
  pageParams,
  paginate,
  paginationLink,
  pathOf,
  queryOf,
  readJsonBody,
  sendJson,
  splitPath,
} from './http.ts';
import { issueComments } from './store.ts';
import type { CommentRecord, Issue, Label, Pull, Repo, Store, User } from './store.ts';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const FIXED_LABEL_COLOR = 'ededed';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Every reply goes through here so the request id is never forgotten. */
function reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': nextRequestId(), ...extra });
}

function replyNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
  res.end();
}

function notFound(res: ServerResponse): void {
  reply(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  reply(res, 422, { message });
}

/** Split a blob's text into lines the way a diff counts them. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Serializers (api.github.com field names, fixed key order)

function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: b64(`User:${user.id}`),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `${API}/users/${user.login}`,
    html_url: `${WEB}/${user.login}`,
    followers_url: `${API}/users/${user.login}/followers`,
    following_url: `${API}/users/${user.login}/following{/other_user}`,
    gists_url: `${API}/users/${user.login}/gists{/gist_id}`,
    starred_url: `${API}/users/${user.login}/starred{/owner}{/repo}`,
    subscriptions_url: `${API}/users/${user.login}/subscriptions`,
    organizations_url: `${API}/users/${user.login}/orgs`,
    repos_url: `${API}/users/${user.login}/repos`,
    events_url: `${API}/users/${user.login}/events{/privacy}`,
    received_events_url: `${API}/users/${user.login}/received_events`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  const openPulls = repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: b64(`Repository:${repo.id}`),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(store.viewer),
    private: repo.private,
    html_url: `${WEB}/${repo.fullName}`,
    description: repo.description,
    fork: repo.fork,
    url: `${API}/repos/${repo.fullName}`,
    archive_url: `${API}/repos/${repo.fullName}/{archive_format}{/ref}`,
    assignees_url: `${API}/repos/${repo.fullName}/assignees{/user}`,
    blobs_url: `${API}/repos/${repo.fullName}/git/blobs{/sha}`,
    branches_url: `${API}/repos/${repo.fullName}/branches{/branch}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    collaborators_url: `${API}/repos/${repo.fullName}/collaborators{/collaborator}`,
    comments_url: `${API}/repos/${repo.fullName}/comments{/number}`,
    commits_url: `${API}/repos/${repo.fullName}/commits{/sha}`,
    compare_url: `${API}/repos/${repo.fullName}/compare/{base}...{head}`,
    contents_url: `${API}/repos/${repo.fullName}/contents/{+path}`,
    contributors_url: `${API}/repos/${repo.fullName}/contributors`,
    deployments_url: `${API}/repos/${repo.fullName}/deployments`,
    downloads_url: `${API}/repos/${repo.fullName}/downloads`,
    events_url: `${API}/repos/${repo.fullName}/events`,
    forks_url: `${API}/repos/${repo.fullName}/forks`,
    git_commits_url: `${API}/repos/${repo.fullName}/git/commits{/sha}`,
    git_refs_url: `${API}/repos/${repo.fullName}/git/refs{/sha}`,
    git_tags_url: `${API}/repos/${repo.fullName}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.fullName}.git`,
    issue_comment_url: `${API}/repos/${repo.fullName}/issues/comments{/number}`,
    issue_events_url: `${API}/repos/${repo.fullName}/issues/events{/number}`,
    issues_url: `${API}/repos/${repo.fullName}/issues{/number}`,
    keys_url: `${API}/repos/${repo.fullName}/keys{/key_id}`,
    labels_url: `${API}/repos/${repo.fullName}/labels{/name}`,
    languages_url: `${API}/repos/${repo.fullName}/languages`,
    merges_url: `${API}/repos/${repo.fullName}/merges`,
    milestones_url: `${API}/repos/${repo.fullName}/milestones{/number}`,
    notifications_url: `${API}/repos/${repo.fullName}/notifications{?since,all,participating}`,
    pulls_url: `${API}/repos/${repo.fullName}/pulls{/number}`,
    releases_url: `${API}/repos/${repo.fullName}/releases{/id}`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    stargazers_url: `${API}/repos/${repo.fullName}/stargazers`,
    statuses_url: `${API}/repos/${repo.fullName}/statuses/{sha}`,
    subscribers_url: `${API}/repos/${repo.fullName}/subscribers`,
    subscription_url: `${API}/repos/${repo.fullName}/subscription`,
    tags_url: `${API}/repos/${repo.fullName}/tags`,
    teams_url: `${API}/repos/${repo.fullName}/teams`,
    trees_url: `${API}/repos/${repo.fullName}/git/trees{/sha}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues + openPulls,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: b64(`Label:${label.id}`),
    url: `${API}/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueLabelJson(repo: Repo, name: string): Record<string, unknown> {
  const found = repo.labels.find((label) => label.name === name);
  if (found !== undefined) return labelJson(repo, found);
  return {
    id: 0,
    node_id: b64(`Label:0`),
    url: `${API}/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
    name,
    color: FIXED_LABEL_COLOR,
    default: false,
    description: null,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64(`Issue:${issue.id}`),
    url: `${API}/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${API}/repos/${repo.fullName}`,
    labels_url: `${API}/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${API}/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${API}/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `${WEB}/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(store.viewer),
    labels: issue.labels.map((name) => issueLabelJson(repo, name)),
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function pullRefJson(store: Store, repo: Repo, ref: { ref: string; sha: string; repo: string }): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref.ref}`,
    ref: ref.ref,
    sha: ref.sha,
    user: userJson(store.viewer),
    repo: repoJson(store, repo),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: b64(`PullRequest:${pull.id}`),
    url: `${API}/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `${WEB}/${repo.fullName}/pull/${pull.number}`,
    diff_url: `${WEB}/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `${WEB}/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${API}/repos/${repo.fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged: pull.merged,
    draft: pull.draft,
    user: userJson(store.viewer),
    head: pullRefJson(store, repo, pull.head),
    base: pullRefJson(store, repo, pull.base),
  };
}

function commentJson(store: Store, repo: Repo, issueNumber: number, comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: b64(`IssueComment:${comment.id}`),
    url: `${API}/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `${WEB}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(store.viewer),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${API}/repos/${repo.fullName}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// Git helpers built on the store's primitives (branch-aware, flat-tree based)

type FlatTree = Map<string, { mode: string; sha: string }>;

/** Build a nested tree object from a flat path -> entry map. */
function buildTreeFromFlat(store: Store, repo: Repo, flat: FlatTree): string {
  const buildLevel = (relative: FlatTree): string => {
    const entries: Array<{ name: string; mode: string; sha: string }> = [];
    const dirs = new Map<string, FlatTree>();
    for (const [path, entry] of relative) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        entries.push({ name: path, mode: entry.mode, sha: entry.sha });
      } else {
        const dir = path.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), entry);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ name: dir, mode: '40000', sha: buildLevel(sub) });
    }
    return store.buildTree(repo, entries);
  };
  return buildLevel(flat);
}

/** Every file in the tree of one commit sha, recursively. Null when unknown. */
function readTreeAtCommit(store: Store, repo: Repo, commitSha: string): FlatTree | null {
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const { tree } = store.parseCommit(commit.content);
  const out: FlatTree = new Map();
  const walk = (treeSha: string, prefix: string): void => {
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of store.parseTree(obj.content)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(tree, '');
  return out;
}

/**
 * Resolve a ref-ish to a commit sha: a full ref, a short branch name, HEAD,
 * a full sha, or a unique abbreviated sha. Undefined when nothing matches.
 */
function resolveCommitSha(store: Store, repo: Repo, ref: string): string | undefined {
  const byRef = store.resolveRef(repo, ref);
  if (byRef !== undefined) return byRef;
  const direct = repo.objects.get(ref);
  if (direct !== undefined && direct.type === 'commit') return ref;
  if (/^[0-9a-f]{7,39}$/i.test(ref)) {
    const matches = [...repo.objects.entries()].filter(
      ([sha, obj]) => obj.type === 'commit' && sha.toLowerCase().startsWith(ref.toLowerCase()),
    );
    if (matches.length === 1) return matches[0]?.[0];
  }
  return undefined;
}

/** Write or replace one file on `refName` (a full `refs/heads/...` ref). */
function writeFileOnRef(
  store: Store,
  repo: Repo,
  refName: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; treeSha: string } {
  const tip = repo.refs.get(refName);
  const flat: FlatTree = tip === undefined ? new Map() : (readTreeAtCommit(store, repo, tip) ?? new Map());
  const blobSha = store.writeBlob(repo, content);
  flat.set(path, { mode: '100644', sha: blobSha });
  const treeSha = buildTreeFromFlat(store, repo, flat);
  const commitSha = store.commitTree(repo, treeSha, tip === undefined ? [] : [tip], message);
  repo.refs.set(refName, commitSha);
  repo.updatedAt = store.nowIso();
  return { commitSha, blobSha, treeSha };
}

/** Delete one file on `refName`. Null when the file is not there. */
function deleteFileOnRef(
  store: Store,
  repo: Repo,
  refName: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const flat = readTreeAtCommit(store, repo, tip);
  if (flat === null || !flat.has(path)) return null;
  flat.delete(path);
  const treeSha = buildTreeFromFlat(store, repo, flat);
  const commitSha = store.commitTree(repo, treeSha, [tip], message);
  repo.refs.set(refName, commitSha);
  repo.updatedAt = store.nowIso();
  return { commitSha };
}

/** Commits reachable from `tipSha`, tip first, parents after, deduplicated. */
function listCommitShas(store: Store, repo: Repo, tipSha: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tipSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(sha);
    const { parents } = store.parseCommit(obj.content);
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const { tree, parents, message } = store.parseCommit(obj.content);
  const cleanMessage = message.endsWith('\n') ? message.slice(0, -1) : message;
  const date = store.nowIso();
  const author = { name: store.viewer.name, email: store.viewer.email, date };
  return {
    sha,
    node_id: b64(`Commit:${sha}`),
    commit: {
      author,
      committer: author,
      message: cleanMessage,
      tree: { sha: tree, url: `${API}/repos/${repo.fullName}/git/trees/${tree}` },
      url: `${API}/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${API}/repos/${repo.fullName}/commits/${sha}`,
    html_url: `${WEB}/${repo.fullName}/commit/${sha}`,
    comments_url: `${API}/repos/${repo.fullName}/commits/${sha}/comments`,
    author: userJson(store.viewer),
    committer: userJson(store.viewer),
    parents: parents.map((parent) => ({
      sha: parent,
      url: `${API}/repos/${repo.fullName}/commits/${parent}`,
      html_url: `${WEB}/${repo.fullName}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pull-request diff (line LCS over the two trees)

interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  sha: string;
}

function diffLines(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      ops.push({ kind: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', line: b[j] as string });
    j += 1;
  }
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === '+') additions += 1;
    else if (op.kind === '-') deletions += 1;
  }
  if (additions === 0 && deletions === 0) return { additions: 0, deletions: 0, patch: '' };
  const patchLines = [`@@ -1,${n} +1,${m} @@`];
  for (const op of ops) patchLines.push(`${op.kind}${op.line}`);
  return { additions, deletions, patch: patchLines.join('\n') };
}

function pullFiles(store: Store, repo: Repo, pull: Pull): PullFile[] {
  const baseFlat = readTreeAtCommit(store, repo, pull.base.sha) ?? new Map<string, { mode: string; sha: string }>();
  const headTip = store.resolveRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const headFlat = readTreeAtCommit(store, repo, headTip) ?? new Map<string, { mode: string; sha: string }>();
  const names = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: PullFile[] = [];
  for (const filename of [...names].sort()) {
    const base = baseFlat.get(filename);
    const head = headFlat.get(filename);
    if (base !== undefined && head !== undefined && base.sha === head.sha) continue;
    const readBlob = (sha: string): string => {
      const obj = repo.objects.get(sha);
      return obj !== undefined && obj.type === 'blob' ? obj.content.toString('utf8') : '';
    };
    if (base === undefined && head !== undefined) {
      const text = readBlob(head.sha);
      const additions = splitLines(text).length;
      out.push({
        filename,
        status: 'added',
        additions,
        deletions: 0,
        changes: additions,
        patch: additions === 0 ? '' : `@@ -0,0 +1,${additions} @@\n${splitLines(text).map((line) => `+${line}`).join('\n')}`,
        sha: head.sha,
      });
    } else if (base !== undefined && head === undefined) {
      const text = readBlob(base.sha);
      const deletions = splitLines(text).length;
      out.push({
        filename,
        status: 'removed',
        additions: 0,
        deletions,
        changes: deletions,
        patch: deletions === 0 ? '' : `@@ -1,${deletions} +0,0 @@\n${splitLines(text).map((line) => `-${line}`).join('\n')}`,
        sha: base.sha,
      });
    } else if (base !== undefined && head !== undefined) {
      const diff = diffLines(readBlob(base.sha), readBlob(head.sha));
      out.push({
        filename,
        status: 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
        patch: diff.patch,
        sha: head.sha,
      });
    }
  }
  return out;
}

/**
 * The suite's conflict rule (checks-rest pullsMergeConflict): the pull is
 * conflicted when the base has moved since the pull was opened AND the head
 * and the current base disagree on the contents of some shared file path.
 */
function pullIsConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = store.headCommitSha(repo);
  if (baseTip === undefined || baseTip === pull.base.sha) return false;
  const baseFlat = readTreeAtCommit(store, repo, baseTip);
  const headTip = store.resolveRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const headFlat = readTreeAtCommit(store, repo, headTip);
  if (baseFlat === null || headFlat === null) return false;
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    if (baseEntry !== undefined && baseEntry.sha !== headEntry.sha) return true;
  }
  return false;
}

function pullFileJson(repo: Repo, file: PullFile): Record<string, unknown> {
  return {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `${WEB}/${repo.fullName}/blob/${file.sha}/${file.filename}`,
    raw_url: `${API}/repos/${repo.fullName}/contents/${file.filename}`,
    contents_url: `${API}/repos/${repo.fullName}/contents/${file.filename}`,
    patch: file.patch,
  };
}

// ---------------------------------------------------------------------------
// Handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const rawPath = pathOf(req);
  if (!(rawPath === '/api/v3' || rawPath === '/api/v3/' || rawPath.startsWith('/api/v3/'))) return false;
  const method = req.method ?? 'GET';

  // Auth first: every /api/v3 route needs the bearer token.
  if (checkAuth(req, store) !== 'ok') {
    reply(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const sub = rawPath === '/api/v3' ? '' : rawPath.slice('/api/v3'.length);
  const segments = splitPath(sub).map(safeDecode);
  const query = queryOf(req);

  // Read the body for write methods. Malformed JSON is a 400, empty is {}.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    try {
      const parsed = await readJsonBody(req);
      if (!isRecord(parsed)) {
        reply(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      body = parsed;
    } catch (err) {
      if (err instanceof BadJsonError) {
        reply(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      throw err;
    }
  }

  const replyList = (items: readonly unknown[]): void => {
    const { page, perPage } = pageParams(query);
    // Link URLs must be absolute: the suite's client rejects a relative
    // next URL (its sameOrigin check does new URL(a) with no base, which
    // throws). Rebuild the origin the suite dialled from the Host header.
    const host = req.headers.host ?? 'entry';
    const base = `http://${host}${pathOf(req)}`;
    const link = paginationLink(base, page, perPage, items.length);
    reply(res, 200, paginate(items, page, perPage), link === null ? {} : { link });
  };

  // GET / and GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    reply(
      res,
      200,
      {
        current_user_url: `${API}/user`,
        current_user_authorizations_html_url: `https://github.com/settings/applications`,
        authorizations_url: `${API}/authorizations`,
        code_search_url: `${API}/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${API}/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${API}/user/emails`,
        emojis_url: `${API}/emojis`,
        events_url: `${API}/events`,
        feeds_url: `${API}/feeds`,
        followers_url: `${API}/user/followers`,
        following_url: `${API}/user/following{/target}`,
        gists_url: `${API}/gists{/gist_id}`,
        hub_url: `${API}/hub`,
        issue_search_url: `${API}/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${API}/issues`,
        keys_url: `${API}/user/keys`,
        label_search_url: `${API}/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${API}/notifications`,
        organization_url: `${API}/orgs/{org}`,
        organization_repositories_url: `${API}/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${API}/orgs/{org}/teams`,
        public_gists_url: `${API}/gists/public`,
        rate_limit_url: `${API}/rate_limit`,
        repository_url: `${API}/repos/{owner}/{repo}`,
        repository_search_url: `${API}/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${API}/user/repos{?type,page,per_page,sort}`,
        starred_url: `${API}/user/starred{/owner}{/repo}`,
        starred_gists_url: `${API}/gists/starred`,
        topic_search_url: `${API}/search/topics?q={query}{&page,per_page}`,
        user_url: `${API}/users/{user}`,
        user_organizations_url: `${API}/user/orgs`,
        user_repositories_url: `${API}/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${API}/search/users?q={query}{&page,per_page,sort,order}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // GET /meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    reply(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0',
    });
    return true;
  }

  // GET /user, GET/POST /user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return true;
      }
      reply(res, 200, userJson(store.viewer));
      return true;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        replyList(store.listReposByOwner(store.viewer.login).map((repo) => repoJson(store, repo)));
        return true;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          unprocessable(res, 'name is required');
          return true;
        }
        if (store.getRepo(store.viewer.login, name) !== undefined) {
          unprocessable(res, 'Repository creation failed. name already exists on this account');
          return true;
        }
        const description = typeof body.description === 'string' ? body.description : null;
        const repo = store.createRepo(name, description);
        if (typeof body.private === 'boolean') repo.private = body.private as false;
        reply(res, 201, repoJson(store, repo));
        return true;
      }
      notFound(res);
      return true;
    }
    notFound(res);
    return true;
  }

  // /repos/{owner}/{name}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    const repo = store.getRepo(owner, name);
    if (repo === undefined) {
      notFound(res);
      return true;
    }

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        reply(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string' || body.description === null) {
          repo.description = body.description as string | null;
        }
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          const newName = body.name as string;
          if (store.getRepo(owner, newName) !== undefined) {
            unprocessable(res, 'Repository creation failed. name already exists on this account');
            return true;
          }
          store.deleteRepo(owner, repo.name);
          repo.name = newName;
          repo.fullName = `${owner}/${newName}`;
          store.repos.set(repo.fullName, repo);
        }
        repo.updatedAt = store.nowIso();
        reply(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        replyNoContent(res);
        return true;
      }
      notFound(res);
      return true;
    }

    // POST /repos/{o}/{r}/git/refs — create a branch (or other ref).
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        notFound(res);
        return true;
      }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || sha === '') {
        unprocessable(res, 'ref and sha are required');
        return true;
      }
      if (repo.refs.has(ref)) {
        unprocessable(res, 'Reference already exists');
        return true;
      }
      const target = repo.objects.get(sha);
      if (target === undefined || target.type !== 'commit') {
        unprocessable(res, 'Object does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      reply(res, 201, {
        ref,
        node_id: b64(`Ref:${repo.id}:${ref}`),
        url: `${API}/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { type: 'commit', sha, url: `${API}/repos/${repo.fullName}/git/commits/${sha}` },
      });
      return true;
    }

    // GET /repos/{o}/{r}/branches[/{branch}]
    if (rest[0] === 'branches') {
      if (method !== 'GET') {
        notFound(res);
        return true;
      }
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (rest.length === 1) {
        replyList(
          branches.map((branch) => ({
            name: branch.name,
            commit: { sha: branch.sha, url: `${API}/repos/${repo.fullName}/commits/${branch.sha}` },
            protected: false,
          })),
        );
        return true;
      }
      const branchName = rest.slice(1).join('/');
      const found = branches.find((branch) => branch.name === branchName);
      if (found === undefined) {
        notFound(res);
        return true;
      }
      reply(res, 200, {
        name: found.name,
        commit: { sha: found.sha, url: `${API}/repos/${repo.fullName}/commits/${found.sha}` },
        protected: false,
      });
      return true;
    }

    // GET /repos/{o}/{r}/commits[/{sha}]
    if (rest[0] === 'commits') {
      if (method !== 'GET') {
        notFound(res);
        return true;
      }
      if (rest.length === 1) {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveCommitSha(store, repo, ref);
        if (tip === undefined) {
          reply(res, 200, []);
          return true;
        }
        const commits = listCommitShas(store, repo, tip)
          .map((sha) => commitJson(store, repo, sha))
          .filter((entry): entry is Record<string, unknown> => entry !== null);
        replyList(commits);
        return true;
      }
      const sha = resolveCommitSha(store, repo, rest.slice(1).join('/'));
      if (sha === undefined) {
        notFound(res);
        return true;
      }
      reply(res, 200, commitJson(store, repo, sha));
      return true;
    }

    // Contents: GET/PUT/DELETE /repos/{o}/{r}/contents[/{path}]
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const refName = (ref: string): string => `refs/heads/${ref}`;
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveCommitSha(store, repo, ref);
        if (tip === undefined) {
          notFound(res);
          return true;
        }
        const flat = readTreeAtCommit(store, repo, tip);
        if (flat === null) {
          notFound(res);
          return true;
        }
        const entry = contentPath === '' ? undefined : flat.get(contentPath);
        if (contentPath !== '' && entry !== undefined) {
          const blob = repo.objects.get(entry.sha);
          const content = blob !== undefined && blob.type === 'blob' ? blob.content : Buffer.alloc(0);
          reply(res, 200, contentFileJson(store, repo, contentPath, entry.sha, content));
          return true;
        }
        if (contentPath !== '' && entry === undefined) {
          // Maybe a directory: any path below it?
          const prefix = `${contentPath}/`;
          if (![...flat.keys()].some((path) => path.startsWith(prefix))) {
            notFound(res);
            return true;
          }
        }
        reply(res, 200, directoryListingJson(store, repo, flat, contentPath));
        return true;
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (contentB64 === '') {
          unprocessable(res, 'content is required');
          return true;
        }
        if (message === '') {
          unprocessable(res, 'message is required');
          return true;
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const targetRef = refName(branch);
        if (repo.refs.get(targetRef) === undefined && store.headCommitSha(repo) !== undefined) {
          // A named branch that does not exist (an unborn repo accepts any write).
          notFound(res);
          return true;
        }
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const flat = readTreeAtCommit(store, repo, repo.refs.get(targetRef) ?? '');
        const existing = flat?.get(contentPath);
        let status = 201;
        if (existing !== undefined) {
          const givenSha = typeof body.sha === 'string' ? body.sha : '';
          if (givenSha === '') {
            unprocessable(res, "sha wasn't supplied");
            return true;
          }
          if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
            reply(res, 409, { message: 'sha does not match the current file' });
            return true;
          }
          status = 200;
        } else if (typeof body.sha === 'string' && body.sha !== '') {
          unprocessable(res, 'file does not exist');
          return true;
        }
        const written = writeFileOnRef(store, repo, targetRef, contentPath, content, message);
        reply(res, status, {
          content: contentFileJson(store, repo, contentPath, written.blobSha, content),
          commit: commitJson(store, repo, written.commitSha),
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof body.message === 'string' ? body.message : `Delete ${contentPath}`;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const targetRef = refName(branch);
        const flat = readTreeAtCommit(store, repo, repo.refs.get(targetRef) ?? '');
        const existing = flat?.get(contentPath);
        if (existing === undefined) {
          notFound(res);
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== existing.sha.toLowerCase()) {
          reply(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const deleted = deleteFileOnRef(store, repo, targetRef, contentPath, message);
        if (deleted === null) {
          notFound(res);
          return true;
        }
        reply(res, 200, { commit: commitJson(store, repo, deleted.commitSha), content: null });
        return true;
      }
      notFound(res);
      return true;
    }

    // Labels: GET/POST /repos/{o}/{r}/labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        replyList(repo.labels.map((label) => labelJson(repo, label)));
        return true;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          unprocessable(res, 'name is required');
          return true;
        }
        if (repo.labels.some((label) => label.name === name)) {
          unprocessable(res, 'Label already exists');
          return true;
        }
        const color = typeof body.color === 'string' && body.color !== '' ? body.color : FIXED_LABEL_COLOR;
        const description = typeof body.description === 'string' ? body.description : null;
        repo.labelSeq += 1;
        const label: Label = { id: repo.labelSeq, name, color, description };
        repo.labels.push(label);
        reply(res, 201, labelJson(repo, label));
        return true;
      }
      notFound(res);
      return true;
    }

    // Issues
    if (rest[0] === 'issues') {
      // GET/POST /repos/{o}/{r}/issues
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = repo.issues.slice();
          if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
          else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          } else {
            issues.sort((a, b) => b.number - a.number);
          }
          replyList(issues.map((issue) => issueJson(store, repo, issue)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') {
            unprocessable(res, 'title is required');
            return true;
          }
          const labelNames = normalizeLabelNames(body.labels);
          const unknown = labelNames.find((labelName) => !repo.labels.some((label) => label.name === labelName));
          if (unknown !== undefined) {
            unprocessable(res, `Label does not exist: ${unknown}`);
            return true;
          }
          const now = store.nowIso();
          repo.issueSeq += 1;
          const issue: Issue = {
            id: store.nextObjectId(),
            number: repo.issueSeq,
            title,
            body: typeof body.body === 'string' ? body.body : null,
            state: 'open',
            labels: labelNames,
            user: store.viewer.login,
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            comments: 0,
          };
          repo.issues.push(issue);
          reply(res, 201, issueJson(store, repo, issue));
          return true;
        }
        notFound(res);
        return true;
      }

      // /repos/{o}/{r}/issues/{number}[/comments]
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        notFound(res);
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          reply(res, 200, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
          if (body.labels !== undefined) {
            const labelNames = normalizeLabelNames(body.labels);
            const unknown = labelNames.find((labelName) => !repo.labels.some((label) => label.name === labelName));
            if (unknown !== undefined) {
              unprocessable(res, `Label does not exist: ${unknown}`);
              return true;
            }
            issue.labels = labelNames;
          }
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
          }
          issue.updatedAt = store.nowIso();
          reply(res, 200, issueJson(store, repo, issue));
          return true;
        }
        notFound(res);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          replyList(issueComments(issue).map((comment) => commentJson(store, repo, number, comment)));
          return true;
        }
        if (method === 'POST') {
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') {
            unprocessable(res, 'body is required');
            return true;
          }
          const now = store.nowIso();
          const comment: CommentRecord = { id: store.nextObjectId(), body: commentBody, user: store.viewer.login, createdAt: now, updatedAt: now };
          issueComments(issue).push(comment);
          issue.comments += 1;
          issue.updatedAt = now;
          reply(res, 201, commentJson(store, repo, number, comment));
          return true;
        }
        notFound(res);
        return true;
      }
      notFound(res);
      return true;
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      // GET/POST /repos/{o}/{r}/pulls
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = repo.pulls.slice();
          if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
          else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
          pulls.sort((a, b) => b.number - a.number);
          replyList(pulls.map((pull) => pullJson(store, repo, pull)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || headRaw === '') {
            unprocessable(res, 'title and head are required');
            return true;
          }
          const headRef = headRaw.includes(':') ? (headRaw.split(':').slice(1).join(':') as string) : headRaw;
          const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').slice(1).join(':') as string) : baseRaw;
          const headSha = store.resolveRef(repo, `refs/heads/${headRef}`);
          const baseSha = store.resolveRef(repo, `refs/heads/${baseRef}`);
          if (headSha === undefined) {
            unprocessable(res, `head branch not found: ${headRef}`);
            return true;
          }
          if (baseSha === undefined) {
            unprocessable(res, `base branch not found: ${baseRef}`);
            return true;
          }
          if (repo.pulls.some((pull) => pull.state === 'open' && pull.head.ref === headRef && pull.base.ref === baseRef)) {
            unprocessable(res, 'A pull request already exists for this head and base');
            return true;
          }
          const now = store.nowIso();
          repo.pullSeq += 1;
          const pull: Pull = {
            id: store.nextObjectId(),
            number: repo.pullSeq,
            title,
            body: typeof body.body === 'string' ? body.body : null,
            state: 'open',
            merged: false,
            draft: false,
            head: { ref: headRef, sha: headSha, repo: repo.fullName },
            base: { ref: baseRef, sha: baseSha, repo: repo.fullName },
            user: store.viewer.login,
            createdAt: now,
            updatedAt: now,
            mergedAt: null,
            mergeCommitSha: null,
            mergeable: true,
          };
          repo.pulls.push(pull);
          reply(res, 201, pullJson(store, repo, pull));
          return true;
        }
        notFound(res);
        return true;
      }

      // /repos/{o}/{r}/pulls/{number}[/files|/merge]
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        notFound(res);
        return true;
      }
      if (rest.length === 2) {
        if (method !== 'GET') {
          notFound(res);
          return true;
        }
        reply(res, 200, pullJson(store, repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          notFound(res);
          return true;
        }
        replyList(pullFiles(store, repo, pull).map((file) => pullFileJson(repo, file)));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          notFound(res);
          return true;
        }
        if (pull.state !== 'open') {
          reply(res, 405, { message: 'Pull request is already closed' });
          return true;
        }
        if (pullIsConflicted(store, repo, pull)) {
          reply(res, 405, { message: 'Merge conflict: head and base have conflicting changes' });
          return true;
        }
        const baseTip = store.headCommitSha(repo);
        const headTip = store.resolveRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
        if (baseTip === undefined || headTip === undefined) {
          reply(res, 405, { message: 'Cannot merge: missing branch tip' });
          return true;
        }
        const baseAtOpen = readTreeAtCommit(store, repo, pull.base.sha) ?? new Map();
        const headFlat = readTreeAtCommit(store, repo, headTip) ?? new Map();
        const currentBase = readTreeAtCommit(store, repo, baseTip) ?? new Map();
        const merged: FlatTree = new Map(currentBase);
        for (const [path, entry] of headFlat) merged.set(path, entry);
        for (const path of baseAtOpen.keys()) {
          if (!headFlat.has(path)) merged.delete(path);
        }
        const treeSha = buildTreeFromFlat(store, repo, merged);
        const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
        const mergeSha = store.commitTree(repo, treeSha, [baseTip], message);
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, mergeSha);
        repo.updatedAt = store.nowIso();
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.nowIso();
        pull.mergeCommitSha = mergeSha;
        pull.mergeable = false;
        pull.updatedAt = store.nowIso();
        reply(res, 200, { sha: mergeSha, merged: true, message });
        return true;
      }
      notFound(res);
      return true;
    }

    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}

// ---------------------------------------------------------------------------
// Contents helpers

function contentFileJson(
  store: Store,
  repo: Repo,
  path: string,
  sha: string,
  content: Buffer,
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha,
    url: `${API}/repos/${repo.fullName}/contents/${path}`,
    git_url: `${API}/repos/${repo.fullName}/git/blobs/${sha}`,
    html_url: `${WEB}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    download_url: `${API}/repos/${repo.fullName}/contents/${path}`,
    _links: {
      git: `${API}/repos/${repo.fullName}/git/blobs/${sha}`,
      self: `${API}/repos/${repo.fullName}/contents/${path}`,
      html: `${WEB}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function directoryListingJson(store: Store, repo: Repo, flat: FlatTree, dirPath: string): Record<string, unknown>[] {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const files = new Map<string, { mode: string; sha: string }>();
  const dirs = new Map<string, FlatTree>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.set(rest, entry);
    } else {
      const dir = rest.slice(0, slash);
      let sub = dirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(rest.slice(slash + 1), entry);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, entry] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = `${prefix}${name}`;
    const blob = repo.objects.get(entry.sha);
    const size = blob !== undefined && blob.type === 'blob' ? blob.content.length : 0;
    out.push({
      type: 'file',
      size,
      name,
      path,
      sha: entry.sha,
      url: `${API}/repos/${repo.fullName}/contents/${path}`,
      git_url: `${API}/repos/${repo.fullName}/git/blobs/${entry.sha}`,
      html_url: `${WEB}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      download_url: `${API}/repos/${repo.fullName}/contents/${path}`,
      _links: {
        git: `${API}/repos/${repo.fullName}/git/blobs/${entry.sha}`,
        self: `${API}/repos/${repo.fullName}/contents/${path}`,
        html: `${WEB}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      },
    });
  }
  for (const [name, sub] of [...dirs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = `${prefix}${name}`;
    out.push({
      type: 'dir',
      size: 0,
      name,
      path,
      sha: buildTreeFromFlat(store, repo, sub),
      url: `${API}/repos/${repo.fullName}/contents/${path}`,
      git_url: `${API}/repos/${repo.fullName}/git/trees/${buildTreeFromFlat(store, repo, sub)}`,
      html_url: `${WEB}/${repo.fullName}/tree/${repo.defaultBranch}/${path}`,
      download_url: null,
      _links: {
        git: `${API}/repos/${repo.fullName}/git/trees/${buildTreeFromFlat(store, repo, sub)}`,
        self: `${API}/repos/${repo.fullName}/contents/${path}`,
        html: `${WEB}/${repo.fullName}/tree/${repo.defaultBranch}/${path}`,
      },
    });
  }
  return out;
}

/** Labels arrive as strings or `{name}` objects; normalize to names. */
function normalizeLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (isRecord(item) && typeof item.name === 'string') out.push(item.name as string);
  }
  return out;
}
