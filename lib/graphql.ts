// GraphQL v4 surface (POST /api/graphql) for the github-core-clone-01 forge.
//
// A small, purpose-built executor for exactly the documents the suite sends
// (see program/env/src/graphql-client.ts and checks-graphql.ts): no general
// GraphQL engine, no dependencies, Node 22 stdlib only. It parses operation
// names, variables, arguments (including inline enums, lists and input
// objects), nested selections, aliases, inline fragments and named fragments,
// then resolves against the shared Store — the same objects REST reads back,
// so a mutation here is visible over /api/v3 and vice versa.
//
// Determinism: no wall clock, no randomness. Every timestamp comes from
// store.nowIso(); ids are stable base64 global ids (`Type:dbid`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BadJsonError,
  checkAuth,
  isRecord,
  readJsonBody,
  sendBadJson,
  sendJson,
  sendUnauthorized,
} from './http.ts';
import { issueComments } from './store.ts';
import type { CommentRecord, Issue, Label, Pull, Repo, Store, User } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'Field'; name: string; alias: string | null; args: ArgumentNode[]; selections: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string }
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: string[];
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

// ---------------------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------------------

type TokenKind = 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

function describeToken(token: Token): string {
  return token.kind === 'EOF' ? 'end of the document' : `"${token.value}"`;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'Punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('Unterminated string.');
        tokens.push({ kind: 'String', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '"') break;
        if (source[j] === '\n') throw new ParseError('Unterminated string.');
        j += 1;
      }
      if (j >= n) throw new ParseError('Unterminated string.');
      const raw = source.slice(i, j + 1);
      let value: string;
      try {
        value = JSON.parse(raw) as string;
      } catch {
        throw new ParseError('Invalid string.');
      }
      tokens.push({ kind: 'String', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`Unexpected character: ${ch}.`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser (recursive descent over the document shapes the suite sends)
// ---------------------------------------------------------------------------------------------------------

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'Punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new ParseError(`Expected "${value}", found ${describeToken(token)}.`);
    }
  }

  private expectName(expected?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new ParseError(`Expected Name, found ${describeToken(token)}.`);
    if (expected !== undefined && token.value !== expected) {
      throw new ParseError(`Expected "${expected}", found "${token.value}".`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      const token = this.peek();
      if (token.kind === 'Punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'Name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        const name = this.peek().kind === 'Name' ? this.next().value : null;
        const variables = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, variables, selections });
      } else if (token.kind === 'Name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new ParseError(`Unexpected ${describeToken(token)}.`);
      }
    }
    return { operations, fragments };
  }

  /** Variable definitions: parsed for shape, only the names are kept. */
  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (!this.atPunct('(')) return names;
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'EOF') throw new ParseError('Unterminated variable definitions.');
      this.expectPunct('$');
      names.push(this.expectName());
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      if (this.atPunct(',')) this.next();
    }
    this.expectPunct(')');
    return names;
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'EOF') throw new ParseError('Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: ArgumentNode[] = [];
    if (this.atPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'Field', name, alias, args, selections };
  }

  /** Directives (@include, @skip, ...) are not used by the suite; skip them. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'EOF') throw new ParseError('Unterminated arguments.');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      if (this.atPunct(',')) this.next();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'Int') return { kind: 'Int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'Float') return { kind: 'Float', value: Number.parseFloat(token.value) };
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) {
        if (this.peek().kind === 'EOF') throw new ParseError('Unterminated list.');
        values.push(this.parseValue());
        if (this.atPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        if (this.peek().kind === 'EOF') throw new ParseError('Unterminated input object.');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.atPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new ParseError(`Unexpected ${describeToken(token)} as a value.`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Global (Relay) ids: base64 of `Type:dbid`, stable across reads, opaque
// (never the plain database id or issue number).
// ---------------------------------------------------------------------------------------------------------

function globalId(type: string, dbid: number): string {
  return Buffer.from(`${type}:${dbid}`).toString('base64');
}

interface DecodedId {
  type: string | null;
  dbid: number;
}

/** Decode a global id, or a plain numeric id defensively. Null when unparseable. */
function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  if (/^\d+$/.test(id)) return { type: null, dbid: Number(id) };
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
  if (match === null) return null;
  return { type: match[1] as string, dbid: Number(match[2]) };
}

// ---------------------------------------------------------------------------------------------------------
// Introspection schema: the types the suite probes with __type / __schema.
// ---------------------------------------------------------------------------------------------------------

interface SchemaType {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA_TYPES: Record<string, SchemaType> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
      'createdAt', 'updatedAt',
    ],
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'state', 'body', 'author', 'user', 'createdAt', 'updatedAt',
      'closedAt', 'labels', 'comments',
    ],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files', 'author', 'body',
      'createdAt', 'updatedAt',
    ],
  },
  User: { name: 'User', kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: ['id', 'name', 'target'] },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: {
    name: 'PullRequestChangedFileConnection',
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  },
  PullRequestChangedFile: { name: 'PullRequestChangedFile', kind: 'OBJECT', fields: ['path'] },
  IssueCommentConnection: { name: 'IssueCommentConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  LabelConnection: { name: 'LabelConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Label: { name: 'Label', kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  PageInfo: { name: 'PageInfo', kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { name: 'IssueOrderField', kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: {
    name: 'RepositoryPermission',
    kind: 'ENUM',
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  PullRequestMergeMethod: { name: 'PullRequestMergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  CreateIssueInput: { name: 'CreateIssueInput', kind: 'INPUT_OBJECT' },
  CloseIssueInput: { name: 'CloseIssueInput', kind: 'INPUT_OBJECT' },
  CreatePullRequestInput: { name: 'CreatePullRequestInput', kind: 'INPUT_OBJECT' },
  MergePullRequestInput: { name: 'MergePullRequestInput', kind: 'INPUT_OBJECT' },
  AddCommentInput: { name: 'AddCommentInput', kind: 'INPUT_OBJECT' },
};

// ---------------------------------------------------------------------------------------------------------
// Issue comments.
//
// Comment records live on the Issue object in the Store (store.issueComments),
// shared with REST, so a comment created here reads back over
// GET /repos/{o}/{r}/issues/{n}/comments and vice versa.
// ---------------------------------------------------------------------------------------------------------

/** The comment records attached to an issue, creating the list on first use. */
export function readIssueCommentRecords(issue: Issue): CommentRecord[] {
  return issueComments(issue);
}

/** Append a comment record to an issue and keep its count in step. */
export function appendIssueCommentRecord(issue: Issue, record: CommentRecord): void {
  issueComments(issue).push(record);
  issue.comments += 1;
}

// ---------------------------------------------------------------------------------------------------------
// Git tree helpers (for pull-request files and merges), built on the Store's
// public parse/build/commit API.
// ---------------------------------------------------------------------------------------------------------

type TreeMap = Map<string, { mode: string; sha: string }>;

/** Every file in the tree at a commit sha, recursively: path -> {mode, sha}. */
function readTreeAtCommit(store: Store, repo: Repo, commitSha: string): TreeMap {
  const out: TreeMap = new Map();
  const commitObj = repo.objects.get(commitSha);
  if (commitObj === undefined || commitObj.type !== 'commit') return out;
  const { tree } = store.parseCommit(commitObj.content);
  const walk = (treeSha: string, prefix: string): void => {
    for (const [name, entry] of store.treeEntriesMap(repo, treeSha)) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(tree, '');
  return out;
}

/** Write a tree object for a flat path -> entry map, rebuilding nesting. */
function writeTreeFromMap(store: Store, repo: Repo, files: TreeMap): string {
  interface DirNode {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/').filter((segment) => segment !== '');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, { mode: entry.mode, sha: entry.sha });
  }
  const build = (node: DirNode): string => {
    const entries: Array<{ name: string; mode: string; sha: string }> = [];
    for (const [name, entry] of node.files) entries.push({ name, mode: entry.mode, sha: entry.sha });
    for (const [name, dir] of node.dirs) entries.push({ name, mode: '40000', sha: build(dir) });
    return store.buildTree(repo, entries);
  };
  return build(root);
}

/**
 * The three-way mergeability of a pull request, following the forge's conflict
 * rule: head and base share a path the head changed AND the base has moved
 * since the pull was opened (both sides touched it differently).
 */
function computeMergeableState(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headSha = pull.head.sha;
  const baseSha = pull.base.sha;
  if (headSha === '' || baseSha === '') return 'UNKNOWN';
  const currentBaseSha = store.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
  if (currentBaseSha === undefined) return 'UNKNOWN';
  const baseTree = readTreeAtCommit(store, repo, baseSha);
  const headTree = readTreeAtCommit(store, repo, headSha);
  const currentTree = readTreeAtCommit(store, repo, currentBaseSha);
  for (const [path, headEntry] of headTree) {
    const baseEntry = baseTree.get(path);
    if (baseEntry !== undefined && baseEntry.sha === headEntry.sha) continue;
    const currentEntry = currentTree.get(path);
    if (currentEntry?.sha !== baseEntry?.sha && currentEntry?.sha !== headEntry.sha) return 'CONFLICTING';
  }
  for (const [path, baseEntry] of baseTree) {
    if (headTree.has(path)) continue;
    const currentEntry = currentTree.get(path);
    if (currentEntry !== undefined && currentEntry.sha !== baseEntry.sha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Paths changed on the head branch against the pull's base, sorted, limited. */
function changedFilePaths(store: Store, repo: Repo, pull: Pull, first: number | null): string[] {
  const baseTree = readTreeAtCommit(store, repo, pull.base.sha);
  const headTree = readTreeAtCommit(store, repo, pull.head.sha);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (baseTree.get(path)?.sha !== headTree.get(path)?.sha) changed.push(path);
  }
  changed.sort();
  return first === null ? changed : changed.slice(0, first);
}

// ---------------------------------------------------------------------------------------------------------
// Cursor pagination (offset cursors, base64 of `cursor:<offset>`).
// ---------------------------------------------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  let decoded = '';
  try {
    decoded = Buffer.from(after, 'base64').toString('utf8');
  } catch {
    return 0;
  }
  const match = /^cursor:(\d+)$/.exec(decoded);
  if (match !== null) return Number(match[1]);
  if (/^\d+$/.test(after)) return Number(after);
  return 0;
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function pageInfoFor(total: number, start: number, pageSize: number): PageInfoValue {
  const end = Math.min(total, start + pageSize);
  return {
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: end > start ? encodeCursor(start) : null,
    endCursor: end > start ? encodeCursor(end) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------------------

interface GraphQLErrorEntry {
  message: string;
  path?: Array<string | number>;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: GraphQLErrorEntry[];
}

/** A resolved value carrying its GraphQL type, for nested selection sets. */
type NodeValue =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; user: User }
  | { __typename: 'Ref'; name: string; oid: string | null }
  | { __typename: 'Label'; label: Label }
  | { __typename: 'ChangedFile'; path: string }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: CommentRecord }
  | { __typename: 'IssueConnection'; repo: Repo; items: Issue[]; total: number; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: Pull[]; total: number; pageInfo: PageInfoValue }
  | { __typename: 'ChangedFileConnection'; items: string[]; total: number; pageInfo: PageInfoValue }
  | { __typename: 'LabelConnection'; items: Label[] }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue; items: CommentRecord[] }
  | { __typename: 'PageInfo'; info: PageInfoValue }
  | { __typename: 'Edge'; node: NodeValue; cursor: string }
  | { __typename: '__Type'; type: SchemaType }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: '__Schema' }
  | { __typename: 'CreateIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CloseIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: NodeValue | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: NodeValue | null }
  | { __typename: 'AddCommentPayload'; commentEdge: NodeValue | null }
  | { __typename: 'AddCommentEdge'; node: NodeValue | null };

function isNodeValue(value: unknown): value is NodeValue {
  return isRecord(value) && typeof value.__typename === 'string';
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function userNodeForLogin(store: Store, login: string): NodeValue {
  const known = [store.viewer, store.teammate, store.stranger, store.org].find((user) => user.login === login);
  const user: User =
    known ??
    ({ id: 0, login, name: login, email: `${login}@example.invalid`, type: 'User' } as User);
  return { __typename: 'User', user };
}

function findRepoByDbid(store: Store, dbid: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === dbid) return repo;
  }
  return undefined;
}

function findIssueByDbid(store: Store, dbid: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === dbid);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function findPullByDbid(store: Store, dbid: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((entry) => entry.id === dbid);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

/** Resolve a parsed argument value against the operation's variables. */
function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((entry) => valueFromNode(entry, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argValue(field: Extract<SelectionNode, { kind: 'Field' }>, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return valueFromNode(arg.value, ctx.variables);
}

function stringArg(field: Extract<SelectionNode, { kind: 'Field' }>, name: string, ctx: ExecContext): string | null {
  const value = argValue(field, name, ctx);
  return typeof value === 'string' ? value : null;
}

function intArg(field: Extract<SelectionNode, { kind: 'Field' }>, name: string, ctx: ExecContext): number | null {
  const value = argValue(field, name, ctx);
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Resolve a selection set against a typed value, honouring fragments and aliases. */
function resolveSelections(
  parent: NodeValue,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const key = selection.alias ?? selection.name;
      const value = resolveField(parent, selection, ctx, [...path, key]);
      out[key] = materialize(value, selection.selections, ctx, [...path, key]);
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, resolveSelections(parent, fragment.selections, ctx, path));
    } else {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, resolveSelections(parent, selection.selections, ctx, path));
    }
  }
  return out;
}

/** Turn a resolved field value into JSON: recurse into typed values' selections. */
function materialize(
  value: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => materialize(entry, selections, ctx, [...path, index]));
  if (isNodeValue(value)) {
    if (selections.length === 0) return {};
    return resolveSelections(value, selections, ctx, path);
  }
  return value;
}

function unknownField(ctx: ExecContext, parent: NodeValue, name: string, path: Array<string | number>): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.__typename}".`, path });
  return null;
}

/** Issues sorted the way the suite expects: orderBy field, ties by number. */
function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = isRecord(orderBy) ? orderBy : {};
  const direction = order.direction === 'ASC' ? 1 : -1;
  const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
  return [...issues].sort((a, b) => {
    let cmp = 0;
    if (field === 'COMMENTS') cmp = a.comments - b.comments;
    else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp !== 0) return cmp * direction;
    return (a.number - b.number) * direction;
  });
}

function issueConnection(repo: Repo, field: Extract<SelectionNode, { kind: 'Field' }>, ctx: ExecContext): NodeValue {
  const first = intArg(field, 'first', ctx) ?? 30;
  const after = argValue(field, 'after', ctx);
  const states = argValue(field, 'states', ctx);
  const orderBy = argValue(field, 'orderBy', ctx);
  let items = repo.issues;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    items = items.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  items = sortIssues(items, orderBy);
  const start = Math.min(decodeCursor(after), items.length);
  const page = items.slice(start, start + first);
  return {
    __typename: 'IssueConnection',
    repo,
    items: page,
    total: items.length,
    pageInfo: pageInfoFor(items.length, start, first),
  };
}

function pullRequestConnection(repo: Repo, field: Extract<SelectionNode, { kind: 'Field' }>, ctx: ExecContext): NodeValue {
  const first = intArg(field, 'first', ctx) ?? 30;
  const after = argValue(field, 'after', ctx);
  const items = [...repo.pulls].sort((a, b) => b.number - a.number);
  const start = Math.min(decodeCursor(after), items.length);
  const page = items.slice(start, start + first);
  return {
    __typename: 'PullRequestConnection',
    repo,
    items: page,
    total: items.length,
    pageInfo: pageInfoFor(items.length, start, first),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Field resolution, per parent type. Unknown fields push a GraphQL error
// naming the field and resolve to null (HTTP 200, errors array) — never an
// HTTP error. A missing repository / issue / pull request resolves to null
// with NO error.
// ---------------------------------------------------------------------------------------------------------

function resolveField(
  parent: NodeValue,
  field: Extract<SelectionNode, { kind: 'Field' }>,
  ctx: ExecContext,
  path: Array<string | number>,
): unknown {
  const store = ctx.store;
  const name = field.name;

  // Meta fields, available on every type.
  if (name === '__typename') return parent.__typename;
  if (name === '__type' && parent.__typename === 'Query') {
    const typeName = stringArg(field, 'name', ctx);
    const type = typeName === null ? undefined : SCHEMA_TYPES[typeName];
    return type === undefined ? null : ({ __typename: '__Type', type } as NodeValue);
  }
  if (name === '__schema' && parent.__typename === 'Query') {
    return { __typename: '__Schema' } as NodeValue;
  }

  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', user: store.viewer } as NodeValue;
      if (name === 'repository') {
        const owner = stringArg(field, 'owner', ctx);
        const repoName = stringArg(field, 'name', ctx);
        if (owner === null || repoName === null) {
          ctx.errors.push({ message: 'repository requires owner and name arguments.', path });
          return null;
        }
        const repo = store.getRepo(owner, repoName);
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(argValue(field, 'id', ctx));
        if (decoded === null) return null;
        if (decoded.type === 'Repository' || decoded.type === null) {
          const repo = findRepoByDbid(store, decoded.dbid);
          if (repo !== undefined) return repoNode(repo);
          if (decoded.type === 'Repository') return null;
        }
        if (decoded.type === 'Issue' || decoded.type === null) {
          const found = findIssueByDbid(store, decoded.dbid);
          if (found !== undefined) return issueNode(found.repo, found.issue);
          if (decoded.type === 'Issue') return null;
        }
        if (decoded.type === 'PullRequest' || decoded.type === null) {
          const found = findPullByDbid(store, decoded.dbid);
          if (found !== undefined) return pullNode(found.repo, found.pull);
          if (decoded.type === 'PullRequest') return null;
        }
        if (decoded.type === 'User') {
          const user = [store.viewer, store.teammate, store.stranger, store.org].find((entry) => entry.id === decoded.dbid);
          return user === undefined ? null : ({ __typename: 'User', user } as NodeValue);
        }
        return null;
      }
      return unknownField(ctx, parent, name, path);
    }

    case 'Mutation': {
      if (name === 'createIssue') return mutateCreateIssue(field, ctx, path);
      if (name === 'closeIssue') return mutateCloseIssue(field, ctx, path);
      if (name === 'createPullRequest') return mutateCreatePullRequest(field, ctx, path);
      if (name === 'mergePullRequest') return mutateMergePullRequest(field, ctx, path);
      if (name === 'addComment') return mutateAddComment(field, ctx, path);
      return unknownField(ctx, parent, name, path);
    }

    case 'Repository': {
      const repo = parent.repo;
      switch (name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'description':
          return repo.description;
        case 'owner':
          return userNodeForLogin(store, repo.owner);
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch, oid: store.headCommitSha(repo) ?? null } as NodeValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const number = intArg(field, 'number', ctx);
          if (number === null) return null;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, field, ctx);
        case 'pullRequests':
          return pullRequestConnection(repo, field, ctx);
        case 'pullRequest': {
          const number = intArg(field, 'number', ctx);
          if (number === null) return null;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'Issue': {
      const issue = parent.issue;
      switch (name) {
        case 'id':
          return globalId('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'body':
          return issue.body;
        case 'author':
        case 'user':
          return userNodeForLogin(store, issue.user);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'labels': {
          const labels = parent.repo.labels.filter((label) => issue.labels.includes(label.name));
          return { __typename: 'LabelConnection', items: labels } as NodeValue;
        }
        case 'comments':
          return {
            __typename: 'IssueCommentConnection',
            repo: parent.repo,
            issue,
            items: readIssueCommentRecords(issue),
          } as NodeValue;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'PullRequest': {
      const pull = parent.pull;
      switch (name) {
        case 'id':
          return globalId('PullRequest', pull.id);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return computeMergeableState(store, parent.repo, pull);
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'headRefOid':
          return pull.head.sha;
        case 'baseRefOid':
          return pull.base.sha;
        case 'headRef':
          return { __typename: 'Ref', name: pull.head.ref, oid: pull.head.sha } as NodeValue;
        case 'baseRef':
          return { __typename: 'Ref', name: pull.base.ref, oid: pull.base.sha } as NodeValue;
        case 'author':
          return userNodeForLogin(store, pull.user);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'files': {
          const first = intArg(field, 'first', ctx);
          const paths = changedFilePaths(store, parent.repo, pull, first);
          return {
            __typename: 'ChangedFileConnection',
            items: paths,
            total: changedFilePaths(store, parent.repo, pull, null).length,
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: paths.length > 0 ? encodeCursor(0) : null,
              endCursor: paths.length > 0 ? encodeCursor(paths.length) : null,
            } satisfies PageInfoValue,
          } as NodeValue;
        }
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'User': {
      const user = parent.user;
      switch (name) {
        case 'id':
          return globalId('User', user.id);
        case 'login':
          return user.login;
        case 'name':
          return user.name;
        case 'email':
          return user.email;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'Ref': {
      switch (name) {
        case 'id':
          return globalId('Ref', 0);
        case 'name':
          return parent.name;
        case 'target':
          return parent.oid === null ? null : ({ __typename: 'Ref', name: parent.name, oid: parent.oid } as NodeValue);
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'Label': {
      const label = parent.label;
      switch (name) {
        case 'id':
          return globalId('Label', label.id);
        case 'name':
          return label.name;
        case 'color':
          return label.color;
        case 'description':
          return label.description;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'ChangedFile': {
      if (name === 'path') return parent.path;
      return unknownField(ctx, parent, name, path);
    }

    case 'IssueComment': {
      const comment = parent.comment;
      switch (name) {
        case 'id':
          return globalId('IssueComment', comment.id);
        case 'body':
          return comment.body;
        case 'author':
          return userNodeForLogin(store, comment.user);
        case 'createdAt':
          return comment.createdAt;
        case 'updatedAt':
          return comment.updatedAt;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'ChangedFileConnection': {
      switch (name) {
        case 'nodes':
          if (parent.__typename === 'IssueConnection') {
            return parent.items.map((issue) => issueNode(parent.repo, issue));
          }
          if (parent.__typename === 'PullRequestConnection') {
            return parent.items.map((pull) => pullNode(parent.repo, pull));
          }
          return parent.items.map((path) => ({ __typename: 'ChangedFile', path } as NodeValue));
        case 'edges': {
          if (parent.__typename === 'IssueConnection') {
            return parent.items.map((issue, index) => ({
              __typename: 'Edge',
              node: issueNode(parent.repo, issue),
              cursor: encodeCursor(index),
            }) as NodeValue);
          }
          if (parent.__typename === 'PullRequestConnection') {
            return parent.items.map((pull, index) => ({
              __typename: 'Edge',
              node: pullNode(parent.repo, pull),
              cursor: encodeCursor(index),
            }) as NodeValue);
          }
          return parent.items.map((path, index) => ({
            __typename: 'Edge',
            node: { __typename: 'ChangedFile', path } as NodeValue,
            cursor: encodeCursor(index),
          }) as NodeValue);
        }
        case 'pageInfo':
          return { __typename: 'PageInfo', info: parent.pageInfo } as NodeValue;
        case 'totalCount':
          return parent.total;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'LabelConnection': {
      switch (name) {
        case 'nodes':
          return parent.items.map((label) => ({ __typename: 'Label', label } as NodeValue));
        case 'edges':
          return parent.items.map((label, index) => ({
            __typename: 'Edge',
            node: { __typename: 'Label', label } as NodeValue,
            cursor: encodeCursor(index),
          }) as NodeValue);
        case 'pageInfo':
          return {
            __typename: 'PageInfo',
            info: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          } as NodeValue;
        case 'totalCount':
          return parent.items.length;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'IssueCommentConnection': {
      switch (name) {
        case 'nodes':
          return parent.items.map(
            (comment) => ({ __typename: 'IssueComment', repo: parent.repo, issue: parent.issue, comment } as NodeValue),
          );
        case 'edges':
          return parent.items.map((comment, index) => ({
            __typename: 'Edge',
            node: { __typename: 'IssueComment', repo: parent.repo, issue: parent.issue, comment } as NodeValue,
            cursor: encodeCursor(index),
          }) as NodeValue);
        case 'pageInfo':
          return {
            __typename: 'PageInfo',
            info: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          } as NodeValue;
        case 'totalCount':
          return parent.items.length;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'PageInfo': {
      switch (name) {
        case 'hasNextPage':
          return parent.info.hasNextPage;
        case 'hasPreviousPage':
          return parent.info.hasPreviousPage;
        case 'startCursor':
          return parent.info.startCursor;
        case 'endCursor':
          return parent.info.endCursor;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'Edge': {
      if (name === 'node') return parent.node;
      if (name === 'cursor') return parent.cursor;
      return unknownField(ctx, parent, name, path);
    }

    case '__Type': {
      const type = parent.type;
      switch (name) {
        case 'name':
          return type.name;
        case 'kind':
          return type.kind;
        case 'description':
          return null;
        case 'fields':
          return type.fields === undefined
            ? null
            : type.fields.map((fieldName) => ({ __typename: '__Field', name: fieldName } as NodeValue));
        case 'enumValues':
          return type.enumValues === undefined
            ? null
            : type.enumValues.map((value) => ({ __typename: '__EnumValue', name: value } as NodeValue));
        case 'inputFields':
          return null;
        case 'interfaces':
          return [];
        case 'possibleTypes':
          return null;
        case 'specifiedByURL':
          return null;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case '__Field': {
      switch (name) {
        case 'name':
          return parent.name;
        case 'description':
          return null;
        case 'args':
          return [];
        case 'type':
          return null;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case '__EnumValue': {
      switch (name) {
        case 'name':
          return parent.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case '__Schema': {
      switch (name) {
        case 'queryType':
          return { __typename: '__Type', type: SCHEMA_TYPES.Query as SchemaType } as NodeValue;
        case 'mutationType':
          return { __typename: '__Type', type: SCHEMA_TYPES.Mutation as SchemaType } as NodeValue;
        case 'subscriptionType':
          return null;
        case 'types':
          return Object.values(SCHEMA_TYPES).map((type) => ({ __typename: '__Type', type } as NodeValue));
        case 'directives':
          return [];
        default:
          return unknownField(ctx, parent, name, path);
      }
    }

    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue;
      return unknownField(ctx, parent, name, path);
    }

    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest;
      return unknownField(ctx, parent, name, path);
    }

    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge;
      return unknownField(ctx, parent, name, path);
    }

    case 'AddCommentEdge': {
      if (name === 'node') return parent.node;
      return unknownField(ctx, parent, name, path);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Mutations. Each acts on the shared Store, so the REST surface reads the
// same objects back (same numbers, same ids, same refs).
// ---------------------------------------------------------------------------------------------------------

type MutationField = Extract<SelectionNode, { kind: 'Field' }>;

function inputOf(field: MutationField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field, 'input', ctx);
  return isRecord(input) ? input : null;
}

function mutateCreateIssue(field: MutationField, ctx: ExecContext, path: Array<string | number>): NodeValue | null {
  const store = ctx.store;
  const input = inputOf(field, ctx);
  if (input === null) {
    ctx.errors.push({ message: 'createIssue requires an input object.', path });
    return null;
  }
  const decoded = decodeGlobalId(input.repositoryId);
  const repo = decoded === null ? undefined : findRepoByDbid(store, decoded.dbid);
  if (repo === undefined) {
    ctx.errors.push({ message: `Could not resolve to a Repository with the id of "${String(input.repositoryId)}".`, path });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : null;
  if (title === null) {
    ctx.errors.push({ message: 'createIssue requires a title.', path });
    return null;
  }
  const now = store.nowIso();
  const number = repo.issueSeq + 1;
  repo.issueSeq = number;
  const issue: Issue = {
    id: store.nextObjectId(),
    number,
    title,
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    labels: [],
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: 0,
  };
  repo.issues.push(issue);
  return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
}

function mutateCloseIssue(field: MutationField, ctx: ExecContext, path: Array<string | number>): NodeValue | null {
  const store = ctx.store;
  const input = inputOf(field, ctx);
  if (input === null) {
    ctx.errors.push({ message: 'closeIssue requires an input object.', path });
    return null;
  }
  const decoded = decodeGlobalId(input.issueId);
  const found = decoded === null ? undefined : findIssueByDbid(store, decoded.dbid);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to an Issue with the id of "${String(input.issueId)}".`, path });
    return null;
  }
  const { repo, issue } = found;
  const now = store.nowIso();
  issue.state = 'closed';
  issue.closedAt = now;
  issue.updatedAt = now;
  return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
}

function mutateCreatePullRequest(field: MutationField, ctx: ExecContext, path: Array<string | number>): NodeValue | null {
  const store = ctx.store;
  const input = inputOf(field, ctx);
  if (input === null) {
    ctx.errors.push({ message: 'createPullRequest requires an input object.', path });
    return null;
  }
  const decoded = decodeGlobalId(input.repositoryId);
  const repo = decoded === null ? undefined : findRepoByDbid(store, decoded.dbid);
  if (repo === undefined) {
    ctx.errors.push({ message: `Could not resolve to a Repository with the id of "${String(input.repositoryId)}".`, path });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : null;
  const headRefName = typeof input.headRefName === 'string' ? input.headRefName : null;
  const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : null;
  if (title === null || headRefName === null || baseRefName === null) {
    ctx.errors.push({ message: 'createPullRequest requires title, headRefName and baseRefName.', path });
    return null;
  }
  const headSha = store.resolveRef(repo, `refs/heads/${headRefName}`);
  if (headSha === undefined) {
    ctx.errors.push({ message: `Head branch "${headRefName}" does not exist.`, path });
    return null;
  }
  const baseSha = store.resolveRef(repo, `refs/heads/${baseRefName}`);
  if (baseSha === undefined) {
    ctx.errors.push({ message: `Base branch "${baseRefName}" does not exist.`, path });
    return null;
  }
  const now = store.nowIso();
  const number = repo.pullSeq + 1;
  repo.pullSeq = number;
  const pull: Pull = {
    id: store.nextObjectId(),
    number,
    title,
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    merged: false,
    draft: false,
    head: { ref: headRefName, sha: headSha, repo: repo.fullName },
    base: { ref: baseRefName, sha: baseSha, repo: repo.fullName },
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
  };
  pull.mergeable = computeMergeableState(store, repo, pull) === 'MERGEABLE';
  repo.pulls.push(pull);
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
}

function mutateMergePullRequest(field: MutationField, ctx: ExecContext, path: Array<string | number>): NodeValue | null {
  const store = ctx.store;
  const input = inputOf(field, ctx);
  if (input === null) {
    ctx.errors.push({ message: 'mergePullRequest requires an input object.', path });
    return null;
  }
  const decoded = decodeGlobalId(input.pullRequestId);
  const found = decoded === null ? undefined : findPullByDbid(store, decoded.dbid);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to a PullRequest with the id of "${String(input.pullRequestId)}".`, path });
    return null;
  }
  const { repo, pull } = found;
  if (pull.merged) {
    ctx.errors.push({ message: 'Pull request has already been merged.', path });
    return null;
  }
  if (pull.state === 'closed') {
    ctx.errors.push({ message: 'Pull request is closed.', path });
    return null;
  }
  if (computeMergeableState(store, repo, pull) === 'CONFLICTING') {
    ctx.errors.push({ message: 'Pull request is not mergeable.', path });
    return null;
  }
  const currentBaseSha = store.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
  if (currentBaseSha === undefined) {
    ctx.errors.push({ message: 'The base branch has no commits.', path });
    return null;
  }
  // Squash merge: the head's diff against the pull's base, applied to the
  // current base tree, lands as one commit on the default branch.
  const baseTree = readTreeAtCommit(store, repo, pull.base.sha);
  const headTree = readTreeAtCommit(store, repo, pull.head.sha);
  const mergedTree = readTreeAtCommit(store, repo, currentBaseSha);
  for (const [pathEntry, headEntry] of headTree) {
    const baseEntry = baseTree.get(pathEntry);
    if (baseEntry?.sha !== headEntry.sha) mergedTree.set(pathEntry, headEntry);
  }
  for (const pathEntry of baseTree.keys()) {
    if (!headTree.has(pathEntry)) mergedTree.delete(pathEntry);
  }
  const treeSha = writeTreeFromMap(store, repo, mergedTree);
  const commitSha = store.commitTree(repo, treeSha, [currentBaseSha], pull.title);
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
  repo.updatedAt = store.nowIso();
  const now = store.nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = now;
  return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
}

function mutateAddComment(field: MutationField, ctx: ExecContext, path: Array<string | number>): NodeValue | null {
  const store = ctx.store;
  const input = inputOf(field, ctx);
  if (input === null) {
    ctx.errors.push({ message: 'addComment requires an input object.', path });
    return null;
  }
  const decoded = decodeGlobalId(input.subjectId);
  const found = decoded === null ? undefined : findIssueByDbid(store, decoded.dbid);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to an Issue with the id of "${String(input.subjectId)}".`, path });
    return null;
  }
  const body = typeof input.body === 'string' ? input.body : null;
  if (body === null) {
    ctx.errors.push({ message: 'addComment requires a body.', path });
    return null;
  }
  const now = store.nowIso();
  const record: CommentRecord = {
    id: store.nextObjectId(),
    body,
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
  };
  appendIssueCommentRecord(found.issue, record);
  const node: NodeValue = { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment: record };
  return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'AddCommentEdge', node } };
}

// ---------------------------------------------------------------------------------------------------------
// One operation body -> one {data, errors?} envelope.
// ---------------------------------------------------------------------------------------------------------

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: GraphQLErrorEntry[];
}

function executeOperationBody(entry: unknown, store: Store): OperationResult {
  if (!isRecord(entry)) {
    return { data: null, errors: [{ message: 'Each operation must be a JSON object with a query string.' }] };
  }
  const query = entry.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((entryOperation) => entryOperation.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0] as OperationNode;
  } else if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const root: NodeValue = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = resolveSelections(root, operation.selections, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP entry point: POST /api/graphql. Auth first (401), then the JSON body
// (malformed JSON -> 400), then one envelope — or one envelope per operation
// when the body is a JSON array (GitHub's operation batching, in order).
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (checkAuth(req, store) !== 'ok') {
    sendUnauthorized(res, true);
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BadJsonError) {
      sendBadJson(res, true);
      return true;
    }
    throw err;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => executeOperationBody(entry, store)));
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { message: 'Request body must be a JSON object or an array of operations' });
    return true;
  }
  sendJson(res, 200, executeOperationBody(body, store));
  return true;
}
