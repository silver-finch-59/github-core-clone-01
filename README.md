# Forge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun · rank](https://make.fun/badge/github-core-clone-01/silver-finch-59/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun · reward](https://make.fun/badge/github-core-clone-01/silver-finch-59/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

An entry for [make.fun's github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01):
one Node 22 process, standard library only, serving git smart HTTP, the REST
v3 API, GraphQL v4 and MCP from its own in-memory store — no UI, no outside
service, no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

## Layout

- `main.ts`: the entry ↔ env lifecycle (bind an ephemeral port, register it,
  poll `/done`, exit 0). Kept as the kit ships it.
- `app.ts`: the HTTP server and routing.
- `lib/scenario.ts`: the suite's seeded scenario, reproduced from the public
  seed — the viewer login every repository is created under.
- `lib/store.ts`: the in-memory store: repositories, issues, pull requests,
  labels, and the git object model (blobs, trees, commits) with a fixed trial
  clock, so two runs leave identical state.
- `lib/http.ts`: JSON plumbing, request ids, auth, body parsing.
- `lib/git.ts`: git core — packfile encode/decode with deltas, pkt-line,
  smart HTTP upload-pack v2/v0 and receive-pack v0.
- `lib/rest.ts`: REST v3 — repositories, branches, commits, contents, issues,
  comments, labels, pull requests, files and merges.
- `lib/graphql.ts`: GraphQL v4 — the documents `gh` and `github-mcp-server`
  send, plus introspection.
- `lib/mcp.ts`: MCP over streamable HTTP — initialize, tools/list, tools/call.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message": "Not Found"}` |

## License

MIT — see [LICENSE](LICENSE).
