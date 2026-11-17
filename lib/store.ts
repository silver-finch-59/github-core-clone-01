// The forge's store: every repository, issue, pull request and git object,
// in memory, in one process. There is no persistence: a trial is one process
// and the suite's export — not this store — is what must be byte-identical
// across runs. Determinism therefore means: no wall clock, no randomness in
// anything that reaches a response. All timestamps come from the fixed trial
// time (MAKEFUN_TRIAL_NOW when set, else the scenario epoch 2025-01-01), and
// ordering falls back to monotonic counters.

import { createHash } from 'node:crypto';
import { scenarioIdentities, type ScenarioUser } from './scenario.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  content: Buffer;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/** One comment on an issue, shared by the REST and GraphQL surfaces. */
export interface CommentRecord {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  /** The issue's comment records; created lazily by issueComments(). */
  commentRecords?: CommentRecord[];
}

/**
 * The comment records attached to an issue, creating the list on first use.
 * REST and GraphQL both go through here, so a comment created on one surface
 * reads back on the other.
 */
export function issueComments(issue: Issue): CommentRecord[] {
  if (issue.commentRecords === undefined) issue.commentRecords = [];
  return issue.commentRecords;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  draft: false;
  head: { ref: string; sha: string; repo: string };
  base: { ref: string; sha: string; repo: string };
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: false;
  fork: false;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  labelSeq: number;
}

/** The fixed identity every commit the entry writes carries. */
export const COMMIT_AUTHOR_NAME = 'ada iversen';
export const COMMIT_AUTHOR_EMAIL = 'adaiversen@example.invalid';

/** A tree entry: git sorts by name, directories as name + '/'. */
export interface TreeEntry {
  name: string;
  mode: string;
  sha: string;
}

function compareTreeNames(a: string, b: string, aIsDir: boolean, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export class Store {
  readonly viewer: User;
  readonly teammate: User;
  readonly stranger: User;
  readonly org: User;
  readonly repos = new Map<string, Repo>();
  readonly token: string;
  readonly trialNow: Date;
  #counter = 0;
  #repoSeq = 10000;
  #objectSeq = 20000;

  constructor() {
    const ids = scenarioIdentities();
    const toUser = (u: ScenarioUser, type: 'User' | 'Organization'): User => ({
      id: u.id,
      login: u.login,
      name: u.name,
      email: u.email,
      type,
    });
    this.viewer = toUser(ids.viewer, 'User');
    this.teammate = toUser(ids.teammate, 'User');
    this.stranger = toUser(ids.stranger, 'User');
    this.org = { id: 1100, login: ids.org, name: ids.org, email: `${ids.org}@example.invalid`, type: 'Organization' };
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const rawNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = rawNow === '' ? NaN : Date.parse(rawNow);
    this.trialNow = Number.isFinite(parsed) ? new Date(parsed) : new Date('2025-01-01T00:00:00.000Z');
  }

  /** The fixed "now" every timestamp in every response carries. */
  nowIso(): string {
    return this.trialNow.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The fixed epoch seconds git commits carry. */
  nowEpochSec(): number {
    return Math.floor(this.trialNow.getTime() / 1000);
  }

  /** A monotonic counter for ordering ties. */
  seq(): number {
    this.#counter += 1;
    return this.#counter;
  }

  nextObjectId(): number {
    this.#objectSeq += 1;
    return this.#objectSeq;
  }

  // ---------------------------------------------------------- repositories

  createRepo(name: string, description?: string | null): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.#repoSeq,
      owner: this.viewer.login,
      name,
      fullName: `${this.viewer.login}/${name}`,
      description: description ?? null,
      private: false,
      fork: false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      labelSeq: 0,
    };
    this.#repoSeq += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => b.id - a.id);
    return out;
  }

  // ---------------------------------------------------------- git objects

  hashObject(type: GitObjectType, content: Buffer): string {
    const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
    return createHash('sha1').update(header).update(content).digest('hex');
  }

  putObject(repo: Repo, type: GitObjectType, content: Buffer): string {
    const sha = this.hashObject(type, content);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, content });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  writeBlob(repo: Repo, content: Buffer): string {
    return this.putObject(repo, 'blob', content);
  }

  /** Build a tree object from entries, sorted the way git sorts them. */
  buildTree(repo: Repo, entries: TreeEntry[]): string {
    const sorted = entries.slice().sort((a, b) =>
      compareTreeNames(a.name, b.name, a.mode === '40000', b.mode === '40000'));
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'ascii'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.putObject(repo, 'tree', Buffer.concat(parts));
  }

  /** Parse a tree object's entries. */
  parseTree(content: Buffer): Array<{ mode: string; name: string; sha: string }> {
    const entries: Array<{ mode: string; name: string; sha: string }> = [];
    let offset = 0;
    while (offset < content.length) {
      const space = content.indexOf(0x20, offset);
      const nul = content.indexOf(0x00, space);
      if (space < 0 || nul < 0 || nul + 21 > content.length) break;
      const mode = content.subarray(offset, space).toString('ascii');
      const name = content.subarray(space + 1, nul).toString('utf8');
      const sha = content.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha });
      offset = nul + 21;
    }
    return entries;
  }

  /** Write a commit object. Author and committer are the fixed identity. */
  commitTree(repo: Repo, treeSha: string, parents: string[], message: string): string {
    const epoch = this.nowEpochSec();
    const ident = `${COMMIT_AUTHOR_NAME} <${COMMIT_AUTHOR_EMAIL}> ${epoch} +0000`;
    const lines: string[] = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    lines.push('');
    lines.push(message.endsWith('\n') ? message : `${message}\n`);
    return this.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  /** Parse a commit object's tree / parents / message. */
  parseCommit(content: Buffer): { tree: string; parents: string[]; message: string } {
    const text = content.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split < 0 ? text : text.slice(0, split);
    const message = split < 0 ? '' : text.slice(split + 2);
    let tree = '';
    const parents: string[] = [];
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { tree, parents, message };
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  headCommitSha(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Every file in the tree at `ref`, recursively: path -> {mode, sha}. */
  readTreeAt(repo: Repo, ref: string): Map<string, { mode: string; sha: string }> | null {
    const commitSha = this.resolveRef(repo, ref);
    if (commitSha === undefined) return null;
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return null;
    const { tree } = this.parseCommit(commit.content);
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (treeSha: string, prefix: string): void => {
      const obj = repo.objects.get(treeSha);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of this.parseTree(obj.content)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(tree, '');
    return out;
  }

  readBlobAt(repo: Repo, ref: string, path: string): Buffer | null {
    const tree = this.readTreeAt(repo, ref);
    if (tree === null) return null;
    const entry = tree.get(path);
    if (entry === undefined) return null;
    const obj = repo.objects.get(entry.sha);
    if (obj === undefined || obj.type !== 'blob') return null;
    return obj.content;
  }

  /** Write or replace one file on the default branch; returns the new commit. */
  updateFile(repo: Repo, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; treeSha: string } {
    const blobSha = this.writeBlob(repo, content);
    const head = this.headCommitSha(repo);
    const segments = path.split('/').filter((s) => s !== '');
    const fileName = segments[segments.length - 1] as string;
    // Rebuild the tree chain from the root down to the file's directory.
    const rebuild = (dirSegments: string[], index: number, parentTreeSha: string | null): string => {
      const current = parentTreeSha === null ? new Map<string, { mode: string; sha: string }>() : this.treeEntriesMap(repo, parentTreeSha);
      if (index === dirSegments.length) {
        current.set(fileName, { mode: '100644', sha: blobSha });
      } else {
        const dir = dirSegments[index] as string;
        const child = current.get(dir);
        const childTreeSha = child !== undefined && child.mode === '40000' ? child.sha : null;
        const next = rebuild(dirSegments, index + 1, childTreeSha);
        current.set(dir, { mode: '40000', sha: next });
      }
      return this.buildTree(repo, [...current.entries()].map(([name, e]) => ({ name, mode: e.mode, sha: e.sha })));
    };
    let parentTreeSha: string | null = null;
    if (head !== undefined) {
      const commit = repo.objects.get(head);
      if (commit !== undefined && commit.type === 'commit') parentTreeSha = this.parseCommit(commit.content).tree;
    }
    const treeSha = rebuild(segments.slice(0, -1), 0, parentTreeSha);
    const parents = head === undefined ? [] : [head];
    const commitSha = this.commitTree(repo, treeSha, parents, message);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
    repo.updatedAt = this.nowIso();
    return { commitSha, blobSha, treeSha };
  }

  /** Delete one file on the default branch; null when the file is not there. */
  deleteFile(repo: Repo, path: string, message: string): { commitSha: string } | null {
    const head = this.headCommitSha(repo);
    if (head === undefined) return null;
    const tree = this.readTreeAt(repo, `refs/heads/${repo.defaultBranch}`);
    if (tree === null || !tree.has(path)) return null;
    const commit = repo.objects.get(head);
    if (commit === undefined || commit.type !== 'commit') return null;
    const segments = path.split('/').filter((s) => s !== '');
    const rebuild = (dirSegments: string[], index: number, parentTreeSha: string): string | null => {
      const current = this.treeEntriesMap(repo, parentTreeSha);
      if (index === dirSegments.length) {
        current.delete(segments[segments.length - 1] as string);
      } else {
        const dir = dirSegments[index] as string;
        const child = current.get(dir);
        if (child === undefined || child.mode !== '40000') return null;
        const next = rebuild(dirSegments, index + 1, child.sha);
        if (next === null) return null;
        current.set(dir, { mode: '40000', sha: next });
      }
      if (current.size === 0 && index > 0) return '';
      return this.buildTree(repo, [...current.entries()].map(([name, e]) => ({ name, mode: e.mode, sha: e.sha })));
    };
    const treeSha = rebuild(segments.slice(0, -1), 0, this.parseCommit(commit.content).tree);
    if (treeSha === null || treeSha === '') return null;
    const commitSha = this.commitTree(repo, treeSha, [head], message);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
    repo.updatedAt = this.nowIso();
    return { commitSha };
  }

  treeEntriesMap(repo: Repo, treeSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const obj = repo.objects.get(treeSha);
    if (obj !== undefined && obj.type === 'tree') {
      for (const entry of this.parseTree(obj.content)) out.set(entry.name, { mode: entry.mode, sha: entry.sha });
    }
    return out;
  }

  /** True when `ancestorSha` is reachable from `sha` through parent links. */
  isAncestor(repo: Repo, ancestorSha: string, sha: string): boolean {
    if (ancestorSha === sha) return true;
    const seen = new Set<string>();
    const stack: string[] = [sha];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') continue;
      const { parents } = this.parseCommit(obj.content);
      for (const parent of parents) {
        if (parent === ancestorSha) return true;
        stack.push(parent);
      }
    }
    return false;
  }
}
