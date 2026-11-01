import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SearchHit } from '../shared/model.js';
import type { CandidatePresentation } from './candidates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVED = new Set(['hits', 'nextCursor', 'cursor', 'totalCandidates', 'presentation']);

type ReservedPageField = 'hits' | 'nextCursor' | 'cursor' | 'totalCandidates' | 'presentation';
type CursorToken = [1, string, string, number, string];

/** Process-local snapshot storage and capacity settings. */
export interface SearchPagesOptions {
  directory?: string;
  ttlMs?: number;
  maxSnapshots?: number;
}

export interface CreateSearchPageOptions<
  Hit = SearchHit,
  Meta extends object = Record<string, unknown>,
  Presentation = CandidatePresentation | null,
> {
  binding: string;
  hits: Hit[];
  pageSize?: number;
  presentation?: Presentation;
  meta?: Meta;
}

export interface NextSearchPageOptions {
  cursor: string;
  binding: string;
  limit?: number;
}

/** Metadata is retained, except for fields owned by pagination itself. */
export type SearchPage<
  Hit = SearchHit,
  Meta extends object = Record<string, unknown>,
  Presentation = CandidatePresentation | null,
> = Omit<Meta, ReservedPageField> & {
  hits: Hit[];
  nextCursor: string | null;
  totalCandidates: number;
  presentation: Presentation;
};

export interface SearchPageError extends Error {
  code: 'SEARCH_CAPACITY' | 'INVALID_CURSOR' | 'CURSOR_EXPIRED';
}

interface SearchSnapshot<Hit, Meta extends object, Presentation> {
  version: 1;
  instance: string;
  id: string;
  binding: string;
  expiresAt: number;
  hits: Hit[];
  pageSize: number;
  presentation: Presentation;
  meta: Omit<Meta, ReservedPageField>;
  pending?: false;
}

interface PendingSnapshot {
  pending: true;
}

/** JSON round-trips intentionally define snapshot cloning behavior. */
function clone<Value>(value: Value): Value {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed as Value;
}

function fail(code: SearchPageError['code'], message: string): SearchPageError {
  return Object.assign(new Error(message), { code });
}

function checkBinding(binding: string): void {
  if (typeof binding !== 'string')
    throw new TypeError('binding must be a canonical caller/query/scope string');
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new RangeError('page size must be an integer from 1 to 20');
  }
}

/**
 * Immutable JSON snapshots have no index or embedding callbacks.
 * Cursors expire after restart; audit files are never restored or overwritten.
 * Capacity failure never silently evicts an active cursor.
 */
export class SearchPages<
  Hit = SearchHit,
  Meta extends object = Record<string, unknown>,
  Presentation = CandidatePresentation | null,
> {
  #directory: string;
  #ttlMs: number;
  #maxSnapshots: number;
  #instance = randomUUID();
  #key = randomBytes(32);
  #snapshots = new Map<string, SearchSnapshot<Hit, Meta, Presentation> | PendingSnapshot>();

  constructor({ directory, ttlMs = 1_800_000, maxSnapshots = 64 }: SearchPagesOptions = {}) {
    if (typeof directory !== 'string' || !directory.length)
      throw new TypeError('directory is required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0)
      throw new RangeError('ttlMs must be a non-negative integer');
    if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1) {
      throw new RangeError('maxSnapshots must be a positive integer');
    }
    this.#directory = resolve(directory);
    this.#ttlMs = ttlMs;
    this.#maxSnapshots = maxSnapshots;
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.#snapshots) {
      if (!snapshot.pending && snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }

  #signature(instance: string, id: string, offset: number, binding: string): string {
    return createHmac('sha256', this.#key)
      .update(JSON.stringify([1, instance, id, offset, binding]))
      .digest('base64url');
  }

  #cursor(snapshot: SearchSnapshot<Hit, Meta, Presentation>, offset: number): string {
    const signature = this.#signature(this.#instance, snapshot.id, offset, snapshot.binding);
    return Buffer.from(
      JSON.stringify([1, this.#instance, snapshot.id, offset, signature]),
    ).toString('base64url');
  }

  #page(
    snapshot: SearchSnapshot<Hit, Meta, Presentation>,
    offset: number,
    limit: number,
  ): SearchPage<Hit, Meta, Presentation> {
    const end = Math.min(offset + limit, snapshot.hits.length);
    // Clone responses so caller mutations cannot affect cursor replay.
    return {
      ...clone(snapshot.meta),
      hits: clone(snapshot.hits.slice(offset, end)),
      nextCursor: end < snapshot.hits.length ? this.#cursor(snapshot, end) : null,
      totalCandidates: snapshot.hits.length,
      presentation: clone(snapshot.presentation),
    };
  }

  async create({
    binding,
    hits,
    pageSize = 5,
    presentation = null as Presentation,
    meta = {} as Meta,
  }: CreateSearchPageOptions<Hit, Meta, Presentation>): Promise<
    SearchPage<Hit, Meta, Presentation>
  > {
    checkBinding(binding);
    if (!Array.isArray(hits)) throw new TypeError('hits must be an array');
    if (pageSize !== 0 || hits.length) checkLimit(pageSize);
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
      throw new TypeError('meta must be an object');
    const cleanMeta = Object.fromEntries(
      Object.entries(meta).filter(([key]) => !RESERVED.has(key)),
    ) as Omit<Meta, ReservedPageField>;
    const snapshot = clone<SearchSnapshot<Hit, Meta, Presentation>>({
      version: 1,
      instance: this.#instance,
      id: randomUUID(),
      binding,
      expiresAt: Date.now() + this.#ttlMs,
      hits,
      pageSize,
      presentation,
      meta: cleanMeta,
    });
    this.#prune();
    if (this.#snapshots.size >= this.#maxSnapshots) {
      throw fail(
        'SEARCH_CAPACITY',
        'Search snapshot capacity reached; wait for an existing snapshot to expire.',
      );
    }
    // Reserve synchronously, before IO, so concurrent create calls obey the cap.
    this.#snapshots.set(snapshot.id, { pending: true });
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.#directory, `${snapshot.id}.json`), JSON.stringify(snapshot), {
        flag: 'wx',
        mode: 0o600,
      });
      this.#snapshots.set(snapshot.id, snapshot);
    } catch (error) {
      this.#snapshots.delete(snapshot.id);
      throw error;
    }
    return this.#page(snapshot, 0, pageSize);
  }

  async next({
    cursor,
    binding,
    limit,
  }: NextSearchPageOptions): Promise<SearchPage<Hit, Meta, Presentation>> {
    checkBinding(binding);
    if (limit !== undefined) checkLimit(limit);
    let token: CursorToken;
    try {
      if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw new Error();
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(parsed)) throw new Error();
      const fields: unknown[] = parsed;
      if (
        fields.length !== 5 ||
        fields[0] !== 1 ||
        !UUID.test(fields[1] as string) ||
        !UUID.test(fields[2] as string) ||
        !Number.isSafeInteger(fields[3]) ||
        (fields[3] as number) < 1 ||
        typeof fields[4] !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(fields[4])
      )
        throw new Error();
      token = fields as CursorToken;
    } catch {
      throw fail('INVALID_CURSOR', 'Malformed search cursor.');
    }
    const [, instance, id, offset, signature] = token;
    if (instance !== this.#instance) {
      throw fail(
        'CURSOR_EXPIRED',
        'Search cursor belongs to an earlier or different instance; run a new search.',
      );
    }
    const expected = this.#signature(instance, id, offset, binding);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw fail(
        'INVALID_CURSOR',
        'Search cursor signature or caller/query/scope binding does not match.',
      );
    }
    this.#prune();
    const snapshot = this.#snapshots.get(id);
    if (!snapshot || snapshot.pending)
      throw fail('CURSOR_EXPIRED', 'Search snapshot expired; run a new search.');
    if (offset >= snapshot.hits.length)
      throw fail('INVALID_CURSOR', 'Search cursor offset is outside its snapshot.');
    return this.#page(snapshot, offset, limit ?? snapshot.pageSize);
  }
}
