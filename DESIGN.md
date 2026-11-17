# github-core-clone-01 — build design (coordinator's contract)

Entry: a standalone GitHub-compatible git forge, one Node 22 process, stdlib only, no
model calls, no git binary, no network beyond the suite. Deadline Sat 2026-11-21
13:30 WIB. Pace: steady, detail and correctness first. Build order: git core,
then REST, then GraphQL/MCP, then perf tuning.

## Ground truth (read in full before writing code)

- Kit: `~/workspace/makefun-research/kits/github-core-clone-01/github-core-clone-01-kit/`
- `competition.yaml` + `RULES.txt` — the rules (already read by the coordinator).
- `program/env/src/checks-<surface>.ts` + `program/env/src/<surface>-client.ts` —
  THE spec for your surface. Read your pair in full; the checks are the only
  definition of "correct". Also read `program/env/src/wire.ts` (lifecycle, budgets,
  scenario) and `program/env/src/manifest.ts` (groups, workloads, scoring).
- `program/env/src/calibration.json` — T_ref per workload (push 1640.82 ms,
  clone 266.941 ms, read 2759.715 ms, write 348.965 ms).
- Starter: `starter/main.ts` (lifecycle, keep as-is apart from a header comment),
  `starter/app.ts` (2 routes + JSON 404 — the file you grow).

## Repo layout (work dir `~/workspace/makefun-entries/github-core-clone-01/`)

```
main.ts            lifecycle (starter, unchanged apart from header comment)
app.ts             createApp(): HTTP server, routing, auth gate (coordinator)
lib/scenario.ts    deterministic scenario port: viewer/teammate/stranger/org (coordinator)
lib/store.ts       in-memory store + git object model + deterministic clock (coordinator)
lib/http.ts        JSON plumbing: sendJson, readBody, request ids, auth (coordinator)
lib/git.ts         git core: packfile, pkt-line, smart HTTP v0/v2 (GIT AGENT)
lib/rest.ts        REST v3: repos/issues/pulls/contents/labels (REST AGENT)
lib/graphql.ts     GraphQL v4 (GRAPHQL AGENT)
lib/mcp.ts         MCP streamable HTTP (MCP AGENT)
README.md          3 make.fun badges + link to make.fun
LICENSE            MIT, must contain the line `SPDX-License-Identifier: MIT`
package.json       starter's (no dependencies). tsconfig.json: starter's.
.makefun/owner.json  already present, wallet DK6wHGmwmPffr3WFiYYYq1AC3EzprrZnCZPVp8g3u2rw — DO NOT touch
```

## The viewer login (critical)

The suite addresses repositories under the scenario viewer login, and the entry
cannot see the scenario — EXCEPT the scenario is a pure function of the public
seed `SCENARIO_SEED = 0x6a09e667f3bcc909n` (`wire.ts` buildScenario). The entry
reproduces it. Verified against the kit's own buildScenario():

- viewer login `adaiversen` (id 1000, name "ada iversen", email
  `adaiversen@example.invalid`), teammate `quinnkeller`, stranger `olgabauer`,
  org `faint-meadow-org`. `lib/scenario.ts` ports fnv1a64/mix64/Rng/generateUsers
  exactly. Use `scenario.viewer.login` as the owner of every repo created through
  `POST /api/v3/user/repos` and as GraphQL `viewer { login }`. Any other owner in a
  repo path is a 404 (never 403), unless the repo was actually created under that
  owner (repos are only ever created under the viewer login, so in practice: any
  owner != viewer login -> 404).

## Auth

- Token: `process.env.MAKEFUN_SHOP_TOKEN`. Every API call carries
  `Authorization: Bearer <token>`. Missing OR wrong token -> **401** with JSON
  `{"message": ...}`. Exception: `GET /healthz` takes no auth.
- Git smart HTTP: check what `git-client.ts` sends. If it sends the Bearer token
  on info/refs + upload-pack + receive-pack, require it there too (401 without).
  If it sends none, do not require it on git routes. The git agent decides from
  the client source and documents the decision in its report.

## Determinism (replay must be byte-identical)

- NEVER use `Date.now()`, `new Date()`, `Math.random()` or any wall clock for
  anything that reaches a response or a stored object. Use `store.nowIso()` and
  `store.nowEpochSec()` (fixed trial time: `MAKEFUN_TRIAL_NOW` when set, else the
  scenario epoch `2025-01-01T00:00:00Z`) and `store.seq()` (monotonic counter)
  for ordering.
- Git commits created by the entry (contents API writes, merges) use the fixed
  author/committer `ada iversen <adaiversen@example.invalid>` and the fixed epoch.
- JSON objects: build keys in a fixed order. Lists: sort by (created_at desc,
  number desc) where the suite expects newest-first; with fixed timestamps that
  is number desc. Never leak ports, dates or random ids into any response body.

## HTTP plumbing (`lib/http.ts`, coordinator)

- `sendJson(res, status, body, extraHeaders?)`: `application/json; charset=utf-8`,
  `content-length` set, body `JSON.stringify(body) + '\n'`.
- Every `/api/v3` reply (including errors and 404s) carries a non-empty
  `X-GitHub-Request-Id` header. Use `nextRequestId()` — a per-process counter
  rendered as `req-<12 hex digits>` (deterministic, never random).
- `GET /api/v3/` (and `/api/v3`) answers 200 with header
  `x-oauth-scopes: repo, read:org` (lowercase header name as sent; Node sends
  headers case-insensitively, the suite reads them case-insensitively).
- `readJsonBody(req)`: parses the body; on malformed JSON throws a `BadJson`
  error the router turns into **400** JSON `{"message": ...}`. Empty body on
  POST/PUT/PATCH counts as `{}` (no body required) UNLESS the route needs fields.
- Unknown route under any surface: **404** JSON `{"message": "Not Found"}`,
  never HTML. Unknown route outside `/api/v3` also 404 JSON (no request-id
  header needed there, but harmless to include).
- Malformed JSON anywhere: **400** JSON. Wrong method on a known path: **404**
  JSON (GitHub answers 404 for most wrong-method routes; only follow the
  checks files if they say otherwise).

## Store API (`lib/store.ts`, coordinator) — the shared contract

```ts
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: GitObjectType; content: Buffer; }
export interface User { id: number; login: string; name: string; email: string; type: 'User' | 'Organization'; }
export interface Label { id: number; name: string; color: string; description: string | null; }
export interface Issue {
  id: number; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; labels: string[]; user: string; // login
  createdAt: string; updatedAt: string; closedAt: string | null;
  comments: number; // comment count, starts 0
}
export interface Pull {
  id: number; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; merged: boolean; draft: false;
  head: { ref: string; sha: string; repo: string }; // repo = "owner/name"
  base: { ref: string; sha: string; repo: string };
  user: string; createdAt: string; updatedAt: string;
  mergedAt: string | null; mergeCommitSha: string | null; mergeable: boolean;
}
export interface Repo {
  id: number; owner: string; name: string; fullName: string;
  description: string | null; private: false; fork: false;
  defaultBranch: string; // 'main'
  createdAt: string; updatedAt: string; pushedAt: string | null;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // 'refs/heads/main' -> commit sha
  labels: Label[]; issues: Issue[]; pulls: Pull[];
  issueSeq: number; pullSeq: number; labelSeq: number;
}
export class Store {
  readonly viewer: User; readonly teammate: User; readonly stranger: User;
  readonly org: User; // login faint-meadow-org, type Organization
  repos: Map<string, Repo>; // key `${owner}/${name}`
  nowIso(): string; nowEpochSec(): number; seq(): number;
  createRepo(name: string, description?: string | null): Repo; // owner = viewer
  getRepo(owner: string, name: string): Repo | undefined;
  deleteRepo(owner: string, name: string): boolean;
  listReposByOwner(owner: string): Repo[];
  // git objects
  hashObject(type: GitObjectType, content: Buffer): string; // sha1 of "type len\0" + content
  putObject(repo: Repo, type: GitObjectType, content: Buffer): string; // returns sha
  getObject(repo: Repo, sha: string): GitObject | undefined;
  writeBlob(repo: Repo, content: Buffer): string;
  buildTree(repo: Repo, entries: Array<{ name: string; mode: string; sha: string }>): string;
  // entries sorted git-style (by name, directories as name + '/')
  commitTree(repo: Repo, treeSha: string, parents: string[], message: string): string;
  resolveRef(repo: Repo, ref: string): string | undefined; // 'refs/heads/main' or 'HEAD' or short 'main'
  readBlobAt(repo: Repo, ref: string, path: string): Buffer | null;
  readTreeAt(repo: Repo, ref: string): Map<string, { mode: string; sha: string }> | null;
  // path -> {mode, sha} for every file in the tree at ref (recursive)
  updateFile(repo: Repo, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; treeSha: string };
  deleteFile(repo: Repo, path: string, message: string): { commitSha: string } | null;
  isAncestor(repo: Repo, ancestorSha: string, sha: string): boolean; // walk parents
  headCommitSha(repo: Repo): string | undefined; // refs.get('refs/heads/' + defaultBranch)
}
```

Notes for implementers:
- `buildTree` sorts entries the way git does (byte order, trees compared as
  name + '/'). `commitTree` writes `tree <sha>\n[parent <sha>\n...]author ...\n
  committer ...\n\n<message>\n` with the fixed identity and fixed epoch.
- `updateFile`/`deleteFile` create a new commit on the default branch and move
  the ref; they throw when the default branch has no commit yet for delete.
- Repo ids: counter starting at 10000. Issue/pull ids: global counter starting
  at 20000. Label ids: per-repo counter from 1.
- `pushedAt`: null until the first receive-pack push, then `nowIso()`.

## Component contracts

### GIT AGENT — `lib/git.ts`, export `handleGit(req, res, store): Promise<boolean>`
- Read `checks-git.ts` + `git-client.ts` IN FULL first.
- Smart HTTP: `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack`
  (preamble `# service=git-upload-pack` + pkt-line advertisement) and same for
  `git-receive-pack`; missing repo -> **404** on both info/refs GETs, server
  stays up. `POST .../git-upload-pack` (protocol v2 when the client sends
  `Git-Protocol: version=2` — v2 capability advertisement + ls-refs; v0 fallback
  otherwise; v0 advertisement must carry side-band-64k or framing breaks) and
  `POST .../git-receive-pack` (v0 only; advertise report-status, side-band-64k,
  delete-refs).
- Packfiles: encode (v2, with OFS_DELTA/REF_DELTA when profitable; plain objects
  are fine for small repos) and decode (inflate via node:zlib, apply deltas,
  verify shas). Objects arrive via pack; store them with `store.putObject`.
- Receive-pack: parse the pack + ref updates; every update fast-forward only
  (`store.isAncestor`); non-FF -> per-ref `ng <ref> non-fast-forward`, ref does
  NOT move; a push with one FF + one refused ref applies the FF one and answers
  one report line each (`ok` / `ng ...`). Push cannot invent a repo (404 when
  the repo does not exist). Deleting a ref (`000...0` new sha) is allowed when
  delete-refs is advertised. Update `pushedAt` + the ref on success.
- Upload-pack v2: commands `ls-refs` (with `unborn`, `symrefs`, peel?) and
  `fetch` (wants, haves, `done`, packfile with sideband). v0: `want`/`have`/
  `done` + packfile sideband-64k. Serve what the client asks; the client file
  shows the exact command sequence.
- Perf matters here: clone workload = 50 concurrent shallow clones of a
  200-commit repo; push workload = 200 sequential 1 KiB pushes. Keep pack
  generation O(objects) with a reused object cache; avoid re-zipping the same
  blobs repeatedly (cache deflated blobs by sha).

### REST AGENT — `lib/rest.ts`, export `handleRest(req, res, store): Promise<boolean>`
- Read `checks-rest.ts` + `rest-client.ts` IN FULL first.
- Routes (all under `/api/v3`, auth required, X-GitHub-Request-Id on every
  reply): `GET /` (200 + x-oauth-scopes), `GET /meta` (200, non-empty
  `installed_version` string — use `"1.0.0"`), `GET /user/repos` (200 list;
  pagination: `per_page`/`page` query params, `Link` header with rel="next"
  when more pages), `POST /user/repos` (201 repo object),
  `GET /repos/{o}/{r}` (200 repo; 404 JSON unknown), `PATCH /repos/{o}/{r}`
  (200, description updated), `DELETE /repos/{o}/{r}` (204, later GET 404),
  `GET /repos/{o}/{r}/branches` + `GET .../branches/{branch}` (list branch
  names + commit sha; the checks name these — read the checks file for the
  exact shapes), `GET .../commits` + `GET .../commits/{sha}` (commit list /
  single commit with author + message; check what the checks file requires),
  `PUT .../contents/{path}` (201 create / 200 update / 409 stale sha; body
  `{message, content (base64), sha?}`; response `{content: {name, path, sha,
  type, size, ...}, commit: {sha, message, ...}}`), `GET .../contents/{path}`
  (200 `{type: 'file', encoding: 'base64', content, sha, size, name, path}`;
  404 on missing), `DELETE .../contents/{path}` (200 `{commit:{sha}}`, later
  GET 404), `POST .../labels` (201 `{name, ...}`), `GET .../labels` (200 list),
  `POST .../issues` (201 open issue; **422** when it names a label that does
  not exist), `GET .../issues` (200 list, newest first; `state` filter),
  `GET .../issues/{number}` (200; 404 unknown), `PATCH .../issues/{number}`
  (200, state/title/body/labels updated), `POST .../issues/{number}/comments`
  (201) + `GET .../issues/{number}/comments` (200 list),
  `POST .../pulls` (201, state open, head + base), `GET .../pulls` (200 list),
  `GET .../pulls/{number}` (200; 404 unknown),
  `GET .../pulls/{number}/files` (200 list of changed files),
  `PUT .../pulls/{number}/merge` (200 `{sha, merged: true, message}`; squash
  commit lands on the default branch; 404 unknown pull, **405** conflicted),
  `GET /user` (200 `{login, id, ...}` — the MCP client reads the login here).
- Repo/issue/pull object shapes: mirror api.github.com field names
  (`full_name`, `html_url` as `<base>/...` is NOT required — the checks read
  fields, not URLs; include `url`/`html_url` as plausible strings anyway).
  Read the checks file for the exact fields each check asserts.
- Contents writes create real git commits (via `store.updateFile`) on the
  default branch so `GET .../commits` and clones see them. Merge creates a
  squash commit on the default branch containing the head branch's tree diff;
  conflicted = head and base share a file path with different blob shas AND
  the base has moved since the pull was opened (read the checks file for the
  exact conflict rule the suite uses — it constructs the conflict, so match
  its construction).
- Pagination: default `per_page` 30; `Link: <url>; rel="next"` (and `rel="last"`)
  when there are more pages. The pagination check creates 30 repos — get the
  boundary exactly right.

### GRAPHQL AGENT — `lib/graphql.ts`, export `handleGraphql(req, res, store): Promise<boolean>`
- Read `checks-graphql.ts` + `graphql-client.ts` IN FULL first.
- `POST /api/graphql`, body `{"query": ..., "variables": {...}}` (+ optional
  `operationName`). No/invalid Bearer -> exactly **401**. Two operation
  documents in one body -> two results in order. Unknown field -> HTTP **200**
  with `errors` array naming it. Unknown repository -> `data.repository =
  null` with NO errors.
- Introspection (`__type` / `__schema`): `Issue` lists id, number, title, state,
  body; `PullRequest` lists id, number, headRefName, baseRefName, mergeable,
  state, merged, files; `Repository` lists id, databaseId, name, nameWithOwner,
  owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues,
  pullRequests, pullRequest; `SearchType` enumValues include ISSUE.
- `repository.issues` with `orderBy: {field: CREATED_AT, direction: DESC}`
  returns issue numbers descending, ties by number DESC; `states: [OPEN]`
  omits closed issues. `createPullRequest` takes a repository id + a head
  branch pushed over git, opens a PR that REST reads back with the same head
  and base refs. `Query.viewer { login }` returns the viewer login. Node ids:
  `Repository.id` / `Issue.id` / `PullRequest.id` must be stable base64-ish
  global ids the suite can pass back (e.g. `R_<repoId>`, `I_<issueId>`,
  `PR_<pullId>` — read the client for the exact id format it expects; if it
  decodes base64 `Type:id`, use `Buffer.from('Repository:123').toString('base64')`
  style ids).
- Implement a small query parser for the documents the suite sends (do NOT
  write a general GraphQL engine): parse operation name, top-level fields,
  arguments, nested selections, fragments (`... on Type`, `...Frag` +
  definitions), variables, aliases. The client file shows every document.

### MCP AGENT — `lib/mcp.ts`, export `handleMcp(req, res, store): Promise<boolean>`
- Read `checks-mcp.ts` + `mcp-client.ts` IN FULL first.
- `POST /mcp`, JSON-RPC 2.0 over Streamable HTTP, `application/json` replies
  (SSE allowed but plain JSON is simpler and accepted). Every request answers
  inside 3 s. Revision `2026-07-28` (every request declares it; `server/discover`
  answers a result whose `supportedVersions` is a non-empty list of YYYY-MM-DD
  revisions), OR a handshake revision (2025-11-25 or earlier) through
  `initialize` + `notifications/initialized` with an optional `Mcp-Session-Id`.
- `tools/list` offers >= 6 tools incl. `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`
  (a server prefix is allowed, matched as suffix case-insensitively); every
  tool has a non-empty description + `inputSchema` of type object; two
  `tools/list` calls answer the SAME list byte for byte (build it once, reuse).
- `tools/call` args are mapped by the client onto your schema's nearest
  property name; it fills a `full_name` property with `owner/repo`. Accept all
  the documented argument spellings (`owner`/`owner_login`/`org`/..., see
  `checks-mcp.ts` line ~186 alias lists) and the `full_name` form.
- Unknown tool -> JSON-RPC `-32602` or `-32601`, never HTTP 500. A `tools/call`
  missing a required argument -> `isError: true` or `-32602`. A body that is
  not JSON -> HTTP **400** with `-32700`. No Authorization header -> **401**.
  Two concurrent `tools/call` requests keep their own JSON-RPC ids and answer
  for their own arguments.
- Tools act on the SAME store as REST: a repo/issue created over MCP reads back
  over `/api/v3` as the same objects, ids unchanged across reads.

## Verification (coordinator runs these; agents may run them too)

From the kit dir:
```
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun-entries/github-core-clone-01 --driver process
node cli/makefun.mjs verify-instance --kit . --driver process
```
Always `--driver process` (Docker is NOT installed). `grade-local` runs the
same suite on practice trial-0 and prints the score + per-check table.

## Authorship (matters for submission)

Write every source file with the write/edit tools in your own session — never
shell heredocs, never generated output. The transcripts must show the code
being written. Do not paste secrets from any session. No paid APIs, no model
calls in the entry.
