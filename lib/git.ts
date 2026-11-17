// Git smart HTTP: pkt-line, packfile, protocol v2/v0 upload-pack and v0
// receive-pack. Node 22 stdlib only (node:zlib, node:crypto, Buffer).
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// Auth: the suite's git client (kit program/env/src/git-client.ts, GitClient
// .request()) sends `Authorization: Bearer <token>` on every git request
// whenever it was constructed with a token, so these routes require the same
// bearer token as the REST surface whenever the store has one configured
// (MAKEFUN_SHOP_TOKEN). Missing or wrong token -> 401 JSON.
//
// Determinism: no wall clock, no randomness anywhere in this module. Object
// ids, pack bytes and ref advertisements are pure functions of the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import type { GitObjectType } from './store.ts';
import {
  checkAuth,
  pathOf,
  queryOf,
  readBody,
  sendBuffer,
  sendJson,
  sendNotFound,
  sendUnauthorized,
} from './http.ts';

export const ZERO_OID = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte header. */
const PKT_LINE_MAX = 65520;
/** Largest sideband data chunk: pkt-line payload (65516) minus the 1 band byte. */
const SIDEBAND_CHUNK = 65515;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse pkt-lines from `buf` starting at `start`. Stops after the first flush
 * packet when `stopAtFlush` is set (receive-pack: the raw pack follows it) and
 * otherwise consumes the whole buffer. Returns the packets and the offset just
 * past the last consumed packet. Throws on any malformed framing.
 */
function decodePktLines(
  buf: Buffer,
  start = 0,
  stopAtFlush = false,
): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`bad pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of every data packet, in order, control packets dropped. */
function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// object helpers
// ---------------------------------------------------------------------------------------------

interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
}

function parseTagObject(content: Buffer): TagView {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Follow annotated tags to the object they ultimately point at. */
function peelToNonTag(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const target = parseTagObject(obj.content).object;
    if (!/^[0-9a-f]{40}$/.test(target)) return current;
    current = target;
  }
}

/** Refs sorted by name, as git advertises them. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------------------------------------
// packfile: read (decode + delta resolution + sha verification)
// ---------------------------------------------------------------------------------------------

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

interface RawPackEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
  resolved?: PackObject;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA (a thin pack's REF_DELTA base may live in the repo).
 * Every object's SHA-1 is recomputed; any mismatch, bad size or bad trailer
 * checksum throws, so a corrupt pack can never unpack as a success.
 */
function readPack(pack: Buffer, repo: Repo, store: Store): PackObject[] {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      (entry as { baseOffset?: number }).baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      (entry as { baseOid?: string }).baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    (entry as { data: Buffer }).data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): PackObject => {
    if (entry.resolved !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      let base = resolvedByOid.get(wanted);
      if (base !== undefined) {
        const resolved = resolve(base);
        type = resolved.type;
        data = applyDelta(resolved.data, entry.data);
      } else {
        // A REF_DELTA base may be a not-yet-resolved pack entry (a delta on a
        // delta) or an object the repo already holds (thin pack).
        for (const candidate of raw) {
          if (candidate.resolved === undefined && !resolving.has(candidate.offset)) {
            try {
              resolve(candidate);
            } catch {
              // This entry may itself depend on the one being resolved; the
              // lookup below decides whether the base turned up.
            }
          }
        }
        base = resolvedByOid.get(wanted);
        if (base !== undefined) {
          const resolved = resolve(base);
          type = resolved.type;
          data = applyDelta(resolved.data, entry.data);
        } else {
          const external = repo.objects.get(wanted);
          if (external === undefined) {
            throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
          }
          type = external.type;
          data = applyDelta(external.content, entry.data);
        }
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = store.hashObject(type, data);
    const resolved: PackObject = { type, data, oid };
    entry.resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  const objects: PackObject[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!seen.has(resolved.oid)) {
      seen.add(resolved.oid);
      objects.push(resolved);
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// packfile: write (plain objects; deflated payloads cached by oid)
// ---------------------------------------------------------------------------------------------

/** Deflated payloads, keyed by object id: objects are immutable, so a blob
 * deflated once for one clone is reused for every later clone. */
const deflateCache = new Map<string, Buffer>();

function deflatedFor(oid: string, data: Buffer): Buffer {
  const cached = deflateCache.get(oid);
  if (cached !== undefined) return cached;
  const deflated = deflateSync(data);
  if (deflateCache.size > 20000) deflateCache.clear();
  deflateCache.set(oid, deflated);
  return deflated;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas). */
function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflatedFor(object.oid, object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a pack into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

// ---------------------------------------------------------------------------------------------
// fetch planning: what a fetch sends, and where the shallow boundary lands
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects the client does not already hold, sorted by oid for determinism. */
  readonly objects: PackObject[];
  /** Commits that are shallow in the result (their parents were cut off). */
  readonly shallow: string[];
  /** Former shallow boundaries that are no longer shallow after this fetch. */
  readonly unshallow: string[];
  /** Haves the server acknowledges as ancestors of a want. */
  readonly acks: string[];
}

/**
 * Walk an object graph from `roots`, collecting every reachable object. A
 * commit named in `shallowBoundaries` is a leaf: the client holds the commit
 * but not its parents, so the walk must not follow them.
 */
function walkReachable(
  repo: Repo,
  store: Store,
  roots: readonly string[],
  shallowBoundaries: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const { tree, parents } = store.parseCommit(obj.content);
      stack.push(tree);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTagObject(obj.content).object);
    } else if (obj.type === 'tree') {
      for (const entry of store.parseTree(obj.content)) {
        if (entry.mode !== '160000') stack.push(entry.sha);
      }
    }
  }
  return seen;
}

function planFetch(
  repo: Repo,
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowIn);

  // Commit distances from the wants (through tags), shortest first. A commit
  // is included only when depth is null or its distance is below the depth.
  const dist = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') queue.push({ oid: parseTagObject(obj.content).object, d: 0 });
    else if (obj.type === 'commit') queue.push({ oid: want, d: 0 });
  }
  for (let index = 0; index < queue.length; index += 1) {
    const { oid, d } = queue[index] as { oid: string; d: number };
    const known = dist.get(oid);
    if (known !== undefined && known <= d) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    dist.set(oid, d);
    if (depth !== null && d + 1 >= depth) continue;
    for (const parent of store.parseCommit(obj.content).parents) {
      queue.push({ oid: parent, d: d + 1 });
    }
  }

  // Everything reachable from the wants without crossing the depth cutoff:
  // included commits contribute their trees, tags resolve to their targets.
  const wantSet = new Set<string>();
  const stack: string[] = [...wants];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (wantSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    wantSet.add(oid);
    if (obj.type === 'commit') {
      if (!dist.has(oid)) continue;
      const { tree, parents } = store.parseCommit(obj.content);
      stack.push(tree);
      for (const parent of parents) if (dist.has(parent)) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTagObject(obj.content).object);
    } else if (obj.type === 'tree') {
      for (const entry of store.parseTree(obj.content)) {
        if (entry.mode !== '160000') stack.push(entry.sha);
      }
    }
  }

  const haveSet = walkReachable(repo, store, haves, shallowSet);

  const objects: PackObject[] = [];
  for (const oid of [...wantSet].sort()) {
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push({ type: obj.type, data: obj.content, oid });
  }

  // A boundary commit is one whose parent exists but was cut off by depth.
  const shallow: string[] = [];
  for (const oid of [...dist.keys()].sort()) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = store.parseCommit(obj.content).parents;
    if (parents.length > 0 && parents.some((parent) => !dist.has(parent))) shallow.push(oid);
  }

  const unshallow: string[] = [];
  for (const boundary of shallowIn) {
    if (!dist.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = store.parseCommit(obj.content).parents;
    if (parents.every((parent) => dist.has(parent))) unshallow.push(boundary);
  }

  // Acknowledge every have that is an ancestor of (or equal to) a wanted tip.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') wantCommits.push(want);
    else if (obj.type === 'tag') wantCommits.push(peelToNonTag(repo, want));
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (wantCommits.some((want) => store.isAncestor(repo, have, want))) acks.push(have);
  }

  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** Capabilities on a v0 upload-pack advertisement's first line. */
function v0UploadCaps(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow agent=makefun-git/1.0`;
}

/** Capabilities on a v0 receive-pack advertisement's first line. */
function v0ReceiveCaps(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=makefun-git/1.0`;
}

/**
 * A v0 ref advertisement body (after the `# service=...` preamble + flush):
 * HEAD first with the capabilities after a NUL, then the refs in name order,
 * each annotated tag followed by its peeled `^{}` line.
 */
function v0Advertisement(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToNonTag(repo, ref.oid);
        if (peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement body (after the preamble + flush). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('agent=makefun-git/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

/** One info/refs answer: preamble, flush, advertisement, flush. */
function infoRefsBody(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocol: 0 | 2): Buffer {
  const preamble = pktLine(`# service=${service}\n`);
  const flush = pktFlush();
  const body =
    service === 'git-receive-pack' || protocol === 0
      ? v0Advertisement(repo, service === 'git-receive-pack' ? v0ReceiveCaps(repo) : v0UploadCaps(repo))
      : v2Advertisement();
  return Buffer.concat([preamble, flush, body]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** The v2 ls-refs answer: one line per ref, then a flush. */
function lsRefsBody(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is listed only when no ref-prefix filter excludes it.
  if (keep('HEAD')) {
    if (head !== undefined) {
      parts.push(
        pktLine(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`),
      );
    } else if (args.unborn) {
      parts.push(
        pktLine(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`),
      );
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (args.peel && obj !== undefined && obj.type === 'tag') {
      const peeled = peelToNonTag(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (/^[0-9a-f]{40}$/.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth >= 1) args.depth = depth;
    }
    // deepen-since, deepen-not, thin-pack, no-progress, ofs-delta, filter,
    // agent, object-format, command and done carry no state this server needs.
  }
  return args;
}

/** The v2 fetch answer: acknowledgments, shallow-info, packfile sections. */
function fetchV2Body(repo: Repo, store: Store, args: FetchArgs): Buffer {
  const plan = planFetch(repo, store, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // git's own upload-pack sends the acknowledgments section only when the
  // client sent haves: a clone with no haves goes straight to shallow-info
  // or packfile, and a client that sees "acknowledgments" there dies with
  // "expected 'packfile', received 'acknowledgments'".
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(writePack(plan.objects))) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK lines, shallow lines, then the sideband pack. */
function fetchV0Body(repo: Repo, store: Store, args: FetchArgs): Buffer {
  const plan = planFetch(repo, store, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(writePack(plan.objects))) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack response cache
// ---------------------------------------------------------------------------------------------

/**
 * Cache of fully-encoded upload-pack fetch responses (the whole v0/v2 body,
 * packfile included), keyed by everything the bytes depend on.
 *
 * The clone workload issues the same fetch 50 times concurrently (same repo,
 * same wants, depth 1, no haves); the first fetch encodes the pack and the
 * other 49 reuse its bytes. A hit is only ever served when a fresh encode
 * would produce byte-for-byte the same body:
 *
 *   - repo identity: a per-Repo serial (module state, never on the store),
 *     so two different repo objects can never share an entry even if their
 *     numeric ids collide across Store instances in one process;
 *   - revision: bumped on every receive-pack that reaches ref processing,
 *     which covers every store write this module performs (object writes
 *     from unpacking, ref creates/updates/deletes, pushedAt);
 *   - repo state fingerprint: `objects.size` plus the sorted ref list. The
 *     object set is append-only (objects are never removed or rewritten),
 *     so for one repo instance equal size means an equal object set; the
 *     fingerprint additionally covers mutations other surfaces make
 *     (REST contents writes, merges) that this module cannot observe.
 *     Any mutation that could change a pack therefore changes the key.
 *   - the exact fetch parameters, in received order: protocol version (v0
 *     and v2 frame the same pack differently), wants, haves (their order
 *     decides ACK order), shallow boundaries, depth. Parameters the encoder
 *     ignores (agent, filter, thin-pack, ...) are not in the key because
 *     they cannot change the bytes this server produces.
 *
 * The cache lives in module state only: nothing is stored on the repo
 * records, so it can never leak into the state export. Eviction is plain
 * FIFO over insertion order (no clock, no randomness); entries are shared
 * read-only Buffers, never mutated after being stored.
 */
const PACK_CACHE_MAX_ENTRIES = 64;
const packCache = new Map<string, Buffer>();

interface RepoCacheState {
  readonly serial: number;
  revision: number;
}

const repoCacheStates = new WeakMap<Repo, RepoCacheState>();
let nextRepoSerial = 1;

function repoCacheState(repo: Repo): RepoCacheState {
  let state = repoCacheStates.get(repo);
  if (state === undefined) {
    state = { serial: nextRepoSerial, revision: 0 };
    nextRepoSerial += 1;
    repoCacheStates.set(repo, state);
  }
  return state;
}

/** Invalidate every cached fetch for `repo` (called on any mutation). */
function bumpRepoRevision(repo: Repo): void {
  repoCacheState(repo).revision += 1;
}

function fetchCacheKey(repo: Repo, protocol: 0 | 2, args: FetchArgs): string {
  const state = repoCacheState(repo);
  const refs = sortedRefs(repo)
    .map((ref) => `${ref.name}=${ref.oid}`)
    .join(';');
  return JSON.stringify([
    state.serial,
    state.revision,
    repo.objects.size,
    refs,
    protocol,
    args.wants,
    args.haves,
    args.shallow,
    args.depth,
  ]);
}

/** The v0/v2 fetch answer, served from the cache when the key matches. */
function cachedFetchBody(repo: Repo, store: Store, args: FetchArgs, protocol: 0 | 2): Buffer {
  const key = fetchCacheKey(repo, protocol, args);
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const body = protocol === 2 ? fetchV2Body(repo, store, args) : fetchV0Body(repo, store, args);
  if (packCache.size >= PACK_CACHE_MAX_ENTRIES) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, body);
  return body;
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let packets: Packet[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'invalid pkt-line' });
    return;
  }
  const lines = packetLines(packets);
  if (isV2) {
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).replace(/\n$/, '');
    if (command === 'ls-refs') {
      sendBuffer(res, 200, lsRefsBody(repo, parseLsRefsArgs(lines)), UPLOAD_RESULT);
      return;
    }
    if (command === 'fetch') {
      sendBuffer(res, 200, cachedFetchBody(repo, store, parseFetchArgs(lines), 2), UPLOAD_RESULT);
      return;
    }
    sendJson(res, 400, { message: 'unknown upload-pack command' });
    return;
  }
  sendBuffer(res, 200, cachedFetchBody(repo, store, parseFetchArgs(lines), 0), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 only)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface RefResult {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  let packets: Packet[];
  let packOffset: number;
  try {
    const decoded = decodePktLines(body, 0, true);
    packets = decoded.packets;
    packOffset = decoded.consumed;
  } catch {
    sendJson(res, 400, { message: 'invalid pkt-line' });
    return;
  }
  const packBytes = body.subarray(packOffset);

  // The command list: one "<old> <new> <ref>" line per pkt-line, the first
  // carrying the client's capabilities after a NUL.
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) {
      sendJson(res, 400, { message: 'invalid receive-pack command' });
      return;
    }
    commands.push({
      oldOid: match[1] as string,
      newOid: match[2] as string,
      ref: match[3] as string,
    });
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'empty receive-pack command list' });
    return;
  }

  // Unpack first: a bad pack refuses every ref and moves nothing.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo, store);
      for (const object of objects) store.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const results: RefResult[] = [];
  if (!unpackOk) {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  } else {
    let anyOk = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          if (command.oldOid === ZERO_OID) {
            results.push({ ref: command.ref, ok: true, reason: '' });
            anyOk = true;
          } else {
            results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          }
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
          anyOk = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else if (repo.objects.get(command.newOid) === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
          anyOk = true;
        }
      } else {
        // Update: the old value must match, and the old tip must be an
        // ancestor of the new tip (fast-forward only).
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (repo.objects.get(command.newOid) === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        } else if (!store.isAncestor(repo, current, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
          anyOk = true;
        }
      }
    }
    if (anyOk) repo.pushedAt = store.nowIso();
  }

  // Any receive-pack that got this far may have changed what a fetch
  // returns: unpacked objects are stored even when every ref update is
  // refused, and a successful update moves a ref. Invalidate this repo's
  // cached fetch responses; a stale hit would serve a pack a fresh encode
  // would not produce, while a needless miss only costs one re-encode.
  bumpRepoRevision(repo);

  // report-status inside sideband band 1: the report stream is itself
  // pkt-lined ("unpack ok", one "ok"/"ng" line per ref, flush) — the
  // demultiplexed band-1 bytes are read back as pkt-lines, so raw text
  // lines here die in the client with "bad line length character: unpa".
  // The outer sideband stream is then terminated by a flush of its own:
  // without it the client dies with "unexpected disconnect while reading
  // sideband packet".
  const inner: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    inner.push(
      result.ok
        ? pktLine(`ok ${result.ref}\n`)
        : pktLine(`ng ${result.ref} ${result.reason}\n`),
    );
  }
  inner.push(pktFlush());
  const parts: Buffer[] = [...sidebandPack(Buffer.concat(inner)), pktFlush()];
  sendBuffer(res, 200, Buffer.concat(parts), RECEIVE_RESULT);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/**
 * Answer one git smart-HTTP request. Returns true when the path belongs to
 * this surface (even when the answer is an error); the app router only calls
 * this for `/{owner}/{repo}.git/...` paths.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) return false;
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const endpoint = match[3] as string;
  const method = req.method ?? 'GET';

  // The suite's git client sends the bearer token on every git request, so
  // these routes require it whenever the store has a token configured. When
  // no token is configured (local smoke tests), git routes stay open.
  if (store.token !== '' && checkAuth(req, store) !== 'ok') {
    sendUnauthorized(res, false);
    return true;
  }

  if (endpoint === 'info/refs') {
    if (method !== 'GET') {
      sendNotFound(res, false);
      return true;
    }
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendNotFound(res, false);
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendNotFound(res, false);
      return true;
    }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const protocol: 0 | 2 = service === 'git-upload-pack' && isV2 ? 2 : 0;
    sendBuffer(
      res,
      200,
      infoRefsBody(repo, service, protocol),
      service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT,
    );
    return true;
  }

  if (endpoint === 'git-upload-pack') {
    if (method !== 'POST') {
      sendNotFound(res, false);
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendNotFound(res, false);
      return true;
    }
    await handleUploadPack(req, res, store, repo);
    return true;
  }

  // git-receive-pack
  if (method !== 'POST') {
    sendNotFound(res, false);
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendNotFound(res, false);
    return true;
  }
  await handleReceivePack(req, res, store, repo);
  return true;
}
