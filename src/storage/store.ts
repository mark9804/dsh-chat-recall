import lance from './lance.js';
import type { Connection, Table, Query, VectorQuery, Index } from '@lancedb/lancedb';
import { Schema, Field, Utf8, Float64, Bool, Int32, Float32, FixedSizeList } from 'apache-arrow';
import type { RecordBatch } from 'apache-arrow';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { chunkText, CHUNKING_VERSION } from '../core/chunking.js';
import type { Chunk } from '../core/chunking.js';
import { chooseCandidates } from '../core/candidates.js';
import type { CandidatePolicy, CandidatePresentation } from '../core/candidates.js';
import { SearchPages } from '../core/cursors.js';
import type {
  SessionRow,
  VisibleBlock,
  MessageRow,
  IndexedBlock,
  SyncBatch,
  SearchHit,
  Embedder,
  SearchRequest,
  ReadRequest,
  ContextMessage,
  ReadResult,
} from '../shared/model.js';

export type { SearchRequest, ReadRequest, ReadResult } from '../shared/model.js';
export type SyncRequest = SyncBatch;
export type FailureStage = 'afterJournal' | 'afterMessages' | 'afterBlocks' | 'afterCheckpoint';
export type FailureHook = (stage: FailureStage) => void | Promise<void>;
export interface OpenStoreOptions {
  root?: string;
  embedder?: Embedder;
  candidatePolicy?: CandidatePolicy;
  failureHook?: FailureHook;
}
export interface SyncResult {
  session: SessionRow;
  messages: number;
  blocks: number;
  changed: boolean;
}
export interface CheckpointsRequest {
  sessionIds?: string[];
}
export interface CheckpointsResult {
  sessions: SessionRow[];
}
export interface EmbedRequest {
  sessionIds?: string[];
}
export interface EmbedResult {
  new: number;
  reused: number;
  remaining: number;
  remainingUnit: 'blocks';
  spaceId: string | null;
}
export interface SearchCoverage {
  method:
    | 'full-block-substring'
    | 'query-term-coverage-then-bm25'
    | 'exact-flat-cosine'
    | 'ivf-flat-candidates';
  candidateLimit: number;
  exhaustive: boolean;
  examinedCandidates?: number;
  terms?: string[];
  rerank?: 'exact-cosine';
  scopeChunks?: number;
  pendingBlocks?: number;
  annExhaustive?: boolean;
}
export interface SearchMeta {
  coverage: SearchCoverage;
  candidateTruncated: boolean;
}
export interface SearchResult extends SearchMeta {
  hits: SearchHit[];
  nextCursor: string | null;
  totalCandidates: number;
  presentation: CandidatePresentation;
}
export interface SessionsRequest {
  sessionIds?: string[];
  query?: string;
  offset?: number;
  limit?: number;
}
export interface SessionsResult {
  sessions: SessionRow[];
  total: number;
  offset: number;
  nextOffset: number | null;
}
export interface StoreStatus {
  counts: { sessions: number; messages: number; blocks: number; vectors: number };
  checkpoints: SessionRow[];
  embedding: {
    configured: boolean;
    spaceId: string | null;
    dimensions: number | null;
    status: 'config-changed' | 'not-configured' | 'pending' | 'ready';
    chunkingVersion: string;
    pendingBlocks: number;
    completedChunks: number;
  };
  pending: number;
  pendingUnit: 'blocks';
}
export interface RecallStore {
  sync(input: unknown): Promise<SyncResult>;
  checkpoints(input?: CheckpointsRequest): Promise<CheckpointsResult>;
  embed(input?: EmbedRequest): Promise<EmbedResult>;
  search(input: unknown): Promise<SearchResult>;
  read(input?: Partial<ReadRequest>): Promise<ReadResult>;
  sessions(input?: SessionsRequest): Promise<SessionsResult>;
  status(): Promise<StoreStatus>;
  close(): Promise<void>;
}

interface StoredMessage extends MessageRow {
  sourceMessageId: string;
}
interface StoredBatch {
  session: SessionRow;
  messages: StoredMessage[];
  blocks: IndexedBlock[];
}
type StoredVisibleBlock = VisibleBlock &
  ({ type: 'text'; text: string } | { type: 'image' | 'file' });
interface ProgressRow {
  id: string;
  blockId: string;
  sessionId: string;
  textHash: string;
  chunkingVersion: string;
  spaceId: string;
  chunks: number;
}
interface SpaceRow {
  id: string;
  spaceId: string;
  dimensions: number;
}
interface VectorMetadata {
  chunkId: string;
  blockId: string;
  messageId: string;
  sessionId: string;
  origin: string;
  role: string;
  time: number;
  eventSeq: number;
  blockIndex: number;
  textHash: string;
  dedupKey: string;
  chunkingVersion: string;
  spaceId: string;
  start: number;
  end: number;
}
interface VectorRow extends VectorMetadata {
  vector: ArrayLike<number>;
}
interface RankedVector extends VectorRow {
  similarity: number;
}
interface LexicalRow extends IndexedBlock {
  _score?: number;
}
type PendingMetadata = Pick<IndexedBlock, 'id' | 'sessionId' | 'textHash'>;
interface PendingState {
  pending: number;
  completedChunks: number;
}
interface Completion {
  remaining: number;
  row: ProgressRow;
}
interface QueuedChunk {
  text: string;
  completion: Completion;
  row: VectorMetadata;
}
interface CandidateResult extends SearchMeta {
  hits: SearchHit[];
}
type StableRow = Pick<IndexedBlock, 'time' | 'sessionId' | 'eventSeq' | 'blockIndex'>;
type HitRow = Pick<
  IndexedBlock,
  'messageId' | 'sessionId' | 'eventSeq' | 'blockIndex' | 'role' | 'time' | 'textHash'
>;

// This module owns its production schemas. Original text lives in blocks/messages,
// not in vectors or a process-wide corpus array. The worker serializes operations.
const CAP = 1000;
const FLAT_MAX = 10000;
const EMBED_BATCH = 32;
const str = (name: string): Field<Utf8> => new Field(name, new Utf8(), false);
const num = (name: string): Field<Float64> => new Field(name, new Float64(), false);
const sessionSchema = new Schema([
  str('sessionId'),
  str('title'),
  str('cwd'),
  str('origin'),
  num('createdAt'),
  num('inheritedEventCount'),
  num('cursor'),
  str('anchorHash'),
  num('updatedAt'),
]);
const messageSchema = new Schema([
  str('id'),
  str('sessionId'),
  str('title'),
  str('cwd'),
  str('origin'),
  new Field('archived', new Bool(), false),
  num('eventSeq'),
  num('time'),
  str('role'),
  str('sourceMessageId'),
  str('contentJson'),
]);
const blockSchema = new Schema([
  str('id'),
  str('messageId'),
  str('sessionId'),
  str('origin'),
  str('role'),
  num('time'),
  num('eventSeq'),
  new Field('blockIndex', new Int32(), false),
  str('text'),
  str('textHash'),
  str('dedupKey'),
]);
const progressSchema = new Schema([
  str('id'),
  str('blockId'),
  str('sessionId'),
  str('textHash'),
  str('chunkingVersion'),
  str('spaceId'),
  num('chunks'),
]);
const spaceSchema = new Schema([str('id'), str('spaceId'), num('dimensions')]);
const vectorSchema = (dimensions: number): Schema =>
  new Schema([
    str('chunkId'),
    str('blockId'),
    str('messageId'),
    str('sessionId'),
    str('origin'),
    str('role'),
    num('time'),
    num('eventSeq'),
    new Field('blockIndex', new Int32(), false),
    str('textHash'),
    str('dedupKey'),
    str('chunkingVersion'),
    str('spaceId'),
    num('start'),
    num('end'),
    new Field(
      'vector',
      new FixedSizeList(dimensions, new Field('item', new Float32(), false)),
      false,
    ),
  ]);
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sql = (value: unknown): string => `'${String(value).replaceAll("'", "''")}'`;
const inList = (column: string, values: readonly string[]): string =>
  values.length ? `${column} IN (${values.map(sql).join(',')})` : 'false';
function plain(row: unknown): unknown {
  return row !== null &&
    typeof row === 'object' &&
    'toJSON' in row &&
    typeof row.toJSON === 'function'
    ? row.toJSON()
    : row;
}
// The sole Arrow row assertion: queries and streamed batches below select this
// module's own declared schemas (including explicitly named projection columns).
// LanceDB's untyped toArray()/Arrow toJSON boundary must not leak into the backend.
async function rowsOf<T>(query: Query | VectorQuery | Pick<RecordBatch, 'toArray'>): Promise<T[]> {
  return (await query.toArray()).map(plain) as T[];
}
const error = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
function requireThat(condition: unknown, code = 'INVALID_REQUEST'): asserts condition {
  if (!condition) throw error(code);
}
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const string = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const idsOf = (ids: unknown): string[] => {
  requireThat(array(ids) && ids.every((id): id is string => string(id) && id.length > 0));
  return [...new Set(ids)].sort();
};
const order = [
  { columnName: 'time', ascending: true },
  { columnName: 'sessionId', ascending: true },
  { columnName: 'eventSeq', ascending: true },
  { columnName: 'blockIndex', ascending: true },
];
const stable = (a: StableRow, b: StableRow): number =>
  a.time - b.time ||
  a.sessionId.localeCompare(b.sessionId) ||
  a.eventSeq - b.eventSeq ||
  a.blockIndex - b.blockIndex;
const scopeWhere = ({
  sessionIds,
  role,
  from,
  to,
}: Pick<SearchRequest, 'sessionIds' | 'role' | 'from' | 'to'>): string =>
  [
    inList('sessionId', sessionIds),
    role === undefined ? '' : `role = ${sql(role)}`,
    from === undefined ? '' : `time >= ${from}`,
    to === undefined ? '' : `time <= ${to}`,
  ]
    .filter(Boolean)
    .join(' AND ');
const boundary = (text: string, offset: number): boolean =>
  offset > 0 &&
  offset < text.length &&
  /[\uDC00-\uDFFF]/u.test(text[offset]) &&
  /[\uD800-\uDBFF]/u.test(text[offset - 1]);
const safeStart = (text: string, offset: number): number =>
  boundary(text, offset) ? offset - 1 : offset;
const safeEnd = (text: string, offset: number): number =>
  boundary(text, offset) ? offset - 1 : offset;
const boundedText = (text: string, maximum: number): string =>
  text.slice(0, safeEnd(text, Math.min(maximum, text.length)));
function hitOf(row: HitRow, text: string, start = 0, end = text.length): SearchHit {
  start = safeStart(text, Math.max(0, Math.min(start, text.length)));
  end = safeEnd(text, Math.min(text.length, end, start + 800));
  return {
    ref: row.messageId,
    sessionId: row.sessionId,
    eventSeq: row.eventSeq,
    blockIndex: row.blockIndex,
    role: row.role,
    time: row.time,
    textHash: row.textHash,
    excerpt: text.slice(start, end),
    start,
    end,
  };
}
const progressId = (row: Pick<IndexedBlock, 'id' | 'textHash'>): string =>
  digest(JSON.stringify([row.id, row.textHash, CHUNKING_VERSION]));
const chunkId = (
  row: Pick<IndexedBlock, 'id' | 'textHash'>,
  part: Pick<Chunk, 'start' | 'end'>,
  spaceId: string,
): string =>
  digest(JSON.stringify([spaceId, row.id, CHUNKING_VERSION, row.textHash, part.start, part.end]));
function vectorsValid(vectors: unknown, count: number, dimensions?: number): number {
  requireThat(array(vectors) && vectors.length === count, 'INVALID_RESPONSE');
  const first = vectors[0];
  dimensions ??= array(first) ? first.length : undefined;
  requireThat(integer(dimensions, 1), 'INVALID_RESPONSE');
  for (const vector of vectors) {
    requireThat(
      array(vector) &&
        vector.length === dimensions &&
        vector.every((value) => finite(value) && Number.isFinite(Math.fround(value))) &&
        vector.some((value) => finite(value) && Math.fround(value) !== 0),
      'INVALID_RESPONSE',
    );
  }
  return dimensions;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0,
    an = 0,
    bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] ** 2;
    bn += b[i] ** 2;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(an * bn)));
}
async function durableNew(path: string, value: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function upsert<T extends object>(
  table: Table,
  rows: { [K in keyof T]: T[K] }[],
  key = 'id',
  update = false,
): Promise<void> {
  if (!rows.length) return;
  let merge = table.mergeInsert(key).whenNotMatchedInsertAll();
  if (update) merge = merge.whenMatchedUpdateAll();
  await merge.execute(rows);
}
async function lookup<T, K extends keyof T>(
  table: Table,
  column: K & string,
  ids: string[],
): Promise<Map<T[K], T>> {
  const found = new Map<T[K], T>();
  for (let offset = 0; offset < ids.length; offset += 128) {
    for (const row of await rowsOf<T>(
      table.query().where(inList(column, ids.slice(offset, offset + 128))),
    )) {
      found.set(row[column], row);
    }
  }
  return found;
}
function uniqueRows<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const old = seen.get(row.id);
    requireThat(!old || JSON.stringify(old) === JSON.stringify(row), 'SOURCE_CHANGED');
    seen.set(row.id, row);
  }
  return [...seen.values()];
}
// These narrow JSON assertions read only the module's own normalized journal and
// contentJson schema, written below. They intentionally do not add recovery-time
// validation or alter errors for a corrupt cache relative to the original store.
function storedContent(json: string): StoredVisibleBlock[] {
  return JSON.parse(json) as StoredVisibleBlock[];
}
function storedBatch(json: string): StoredBatch {
  return JSON.parse(json) as StoredBatch;
}
function visiblePart(part: unknown): part is StoredVisibleBlock {
  return (
    record(part) &&
    (part.type === 'text' || part.type === 'image' || part.type === 'file') &&
    integer(part.blockIndex) &&
    (part.type !== 'text' || string(part.text))
  );
}
function fieldOf(row: object, name: string): unknown {
  return Reflect.get(row, name);
}

export async function openStore({
  root,
  embedder,
  candidatePolicy = {},
  failureHook,
}: OpenStoreOptions = {}): Promise<RecallStore> {
  requireThat(string(root) && root.length > 0);
  requireThat(
    embedder === undefined ||
      (string(embedder.spaceId) &&
        embedder.spaceId.length > 0 &&
        typeof embedder.embed === 'function'),
  );
  root = resolve(root);
  const journalDirectory = join(root, 'journals');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const db: Connection = await lance.connect(join(root, 'db'));
  const tables: Record<string, Table> = {};
  let interrupted = false,
    closed = false,
    space: SpaceRow | undefined;
  const pages = new SearchPages<SearchHit, SearchMeta, CandidatePresentation>({
    directory: join(root, 'search-pages'),
  });
  const names = new Set(await db.tableNames());
  async function table(name: string, schema?: Schema): Promise<Table> {
    const result = names.has(name)
      ? await db.openTable(name)
      : await db.createEmptyTable(name, schema!);
    names.add(name);
    tables[name] = result;
    return result;
  }
  const sessionsTable = await table('sessions', sessionSchema);
  const messages = await table('messages', messageSchema);
  const blocks = await table('blocks', blockSchema);
  const progress = await table('embedding_progress', progressSchema);
  const spaces = await table('embedding_space', spaceSchema);
  let vectors: Table | undefined;
  function ready(): void {
    requireThat(!closed, 'NOT_PREPARED');
    requireThat(!interrupted, 'SYNC_INCOMPLETE');
  }
  function embeddingReady(): Embedder {
    requireThat(embedder, 'NO_EMBEDDING_CONFIG');
    requireThat(!space || space.spaceId === embedder.spaceId, 'EMBEDDING_CONFIG_CHANGED');
    return embedder;
  }
  async function ensureIndex(target: Table, column: string, config: Index): Promise<void> {
    const indices = await target.listIndices();
    if (!indices.some((index) => index.columns?.includes(column)))
      await target.createIndex(column, { config });
  }
  async function checkpoint(sessionId: string): Promise<SessionRow | undefined> {
    return (
      await rowsOf<SessionRow>(
        sessionsTable
          .query()
          .where(`sessionId = ${sql(sessionId)}`)
          .limit(1),
      )
    )[0];
  }
  async function checkBatch(batch: StoredBatch): Promise<SessionRow | undefined> {
    const previous = await checkpoint(batch.session.sessionId);
    if (previous) {
      requireThat(batch.session.cursor >= previous.cursor, 'SOURCE_CHANGED');
      if (batch.session.cursor === previous.cursor)
        requireThat(batch.session.anchorHash === previous.anchorHash, 'SOURCE_CHANGED');
    }
    async function checkRows<T extends { id: string; eventSeq: number }>(
      target: Table,
      rows: T[],
      fields: string[],
    ): Promise<void> {
      const existing = await lookup<T, 'id'>(
        target,
        'id',
        rows.map((row) => row.id),
      );
      for (const row of rows) {
        const old = existing.get(row.id);
        if (old)
          requireThat(
            fields.every((field) => fieldOf(old, field) === fieldOf(row, field)),
            'SOURCE_CHANGED',
          );
        else requireThat(!previous || row.eventSeq > previous.cursor, 'SOURCE_CHANGED');
      }
    }
    await checkRows(messages, batch.messages, [
      'id',
      'sessionId',
      'eventSeq',
      'time',
      'role',
      'origin',
      'sourceMessageId',
      'contentJson',
    ]);
    await checkRows(
      blocks,
      batch.blocks,
      blockSchema.fields.map((field) => field.name),
    );
    return previous;
  }
  async function apply(batch: StoredBatch, hook?: FailureHook): Promise<void> {
    await upsert(messages, batch.messages);
    await hook?.('afterMessages');
    await upsert(blocks, batch.blocks);
    await hook?.('afterBlocks');
    // The sole authoritative source checkpoint is written last.
    await upsert(sessionsTable, [batch.session], 'sessionId', true);
    await hook?.('afterCheckpoint');
  }
  async function recover(): Promise<void> {
    const files = await readdir(journalDirectory);
    const done = new Set(files.filter((name) => name.endsWith('.done')));
    for (const name of files.filter((name) => name.endsWith('.json')).sort()) {
      if (done.has(`${name}.done`)) continue;
      let batch: StoredBatch;
      try {
        batch = storedBatch(await readFile(join(journalDirectory, name), 'utf8'));
      } catch {
        throw error('SYNC_INCOMPLETE');
      }
      await checkBatch(batch);
      await apply(batch);
      await durableNew(join(journalDirectory, `${name}.done`), 'done\n');
    }
  }
  try {
    await recover();
    await ensureIndex(
      blocks,
      'text',
      lance.Index.fts({
        baseTokenizer: 'ngram',
        ngramMinLength: 1,
        ngramMaxLength: 2,
        prefixOnly: false,
        lowercase: false,
        stem: false,
        removeStopWords: false,
        asciiFolding: false,
        withPosition: false,
      }),
    );
    await ensureIndex(blocks, 'sessionId', lance.Index.btree());
    await ensureIndex(messages, 'id', lance.Index.btree());
    await ensureIndex(sessionsTable, 'sessionId', lance.Index.btree());
    space = (await rowsOf<SpaceRow>(spaces.query().limit(1)))[0];
    if (names.has('vectors')) vectors = await table('vectors');
  } catch (cause) {
    for (const target of Object.values(tables)) target.close();
    db.close();
    throw cause;
  }

  async function normalize(input: unknown): Promise<StoredBatch> {
    requireThat(record(input));
    const { session: source, messages: sourceMessages, blocks: sourceBlocks } = input;
    requireThat(
      record(source) &&
        string(source.sessionId) &&
        source.sessionId.length > 0 &&
        string(source.title) &&
        string(source.cwd) &&
        string(source.origin) &&
        string(source.anchorHash) &&
        finite(source.createdAt) &&
        finite(source.updatedAt) &&
        integer(source.inheritedEventCount) &&
        integer(source.cursor, -1),
    );
    requireThat(array(sourceMessages) && array(sourceBlocks));
    const session: SessionRow = {
      sessionId: source.sessionId,
      title: source.title,
      cwd: source.cwd,
      origin: source.origin,
      createdAt: source.createdAt,
      inheritedEventCount: source.inheritedEventCount,
      cursor: source.cursor,
      anchorHash: source.anchorHash,
      updatedAt: source.updatedAt,
    };
    const normalizedMessages = uniqueRows(
      sourceMessages.map((row): StoredMessage => {
        requireThat(
          record(row) &&
            row.sessionId === session.sessionId &&
            integer(row.eventSeq) &&
            row.eventSeq <= session.cursor &&
            row.id === `${session.sessionId}:${row.eventSeq}` &&
            string(row.title) &&
            string(row.cwd) &&
            string(row.origin) &&
            string(row.role) &&
            string(row.contentJson) &&
            finite(row.time),
        );
        let content: unknown;
        try {
          content = JSON.parse(row.contentJson);
        } catch {
          throw error('INVALID_REQUEST');
        }
        requireThat(array(content) && content.every(visiblePart));
        requireThat(new Set(content.map((part) => part.blockIndex)).size === content.length);
        const sourceMessageId =
          row.sourceMessageId ??
          content.find((part) => string(part.originalMessageId))?.originalMessageId ??
          '';
        requireThat(string(sourceMessageId));
        return {
          id: row.id,
          sessionId: row.sessionId,
          title: row.title,
          cwd: row.cwd,
          origin: row.origin,
          archived: false,
          eventSeq: row.eventSeq,
          time: row.time,
          role: row.role,
          sourceMessageId,
          contentJson: JSON.stringify(content),
        };
      }),
    );
    const messageMap = new Map(normalizedMessages.map((row) => [row.id, row]));
    const missing = [
      ...new Set(
        sourceBlocks
          .map((row) => (record(row) ? row.messageId : undefined))
          .filter((id): id is string => string(id) && !messageMap.has(id)),
      ),
    ];
    for (const [id, row] of await lookup<StoredMessage, 'id'>(messages, 'id', missing))
      messageMap.set(id, row);
    const existingBlocks = await lookup<IndexedBlock, 'id'>(
      blocks,
      'id',
      sourceBlocks.map((row) => (record(row) ? row.id : undefined)).filter(string),
    );
    const normalizedBlocks = uniqueRows(
      sourceBlocks.map((row): IndexedBlock => {
        requireThat(
          record(row) &&
            row.sessionId === session.sessionId &&
            integer(row.eventSeq) &&
            row.eventSeq <= session.cursor &&
            integer(row.blockIndex, 0, 2147483647) &&
            row.messageId === `${session.sessionId}:${row.eventSeq}` &&
            row.id === `${row.messageId}:${row.blockIndex}` &&
            string(row.origin) &&
            string(row.role) &&
            string(row.text) &&
            finite(row.time),
        );
        const existing = existingBlocks.get(row.id);
        if (existing)
          requireThat(
            [
              'messageId',
              'sessionId',
              'origin',
              'role',
              'time',
              'eventSeq',
              'blockIndex',
              'text',
            ].every((field) => fieldOf(existing, field) === row[field]),
            'SOURCE_CHANGED',
          );
        const message = messageMap.get(row.messageId);
        requireThat(
          message &&
            message.role === row.role &&
            message.time === row.time &&
            message.origin === row.origin,
        );
        const part = storedContent(message.contentJson).find(
          (item) => item.blockIndex === row.blockIndex,
        );
        requireThat(part?.type === 'text' && part.text === row.text);
        const textHash = digest(row.text);
        const original = part.originalMessageId ?? message.sourceMessageId;
        requireThat(original === undefined || string(original));
        const dedupKey = original
          ? digest(JSON.stringify([original, row.role, row.blockIndex, textHash]))
          : row.id;
        return {
          id: row.id,
          messageId: row.messageId,
          sessionId: row.sessionId,
          origin: row.origin,
          role: row.role,
          time: row.time,
          eventSeq: row.eventSeq,
          blockIndex: row.blockIndex,
          text: row.text,
          textHash,
          dedupKey,
        };
      }),
    );
    const blockIds = new Set(normalizedBlocks.map((row) => row.id));
    // A checkpoint must never hide a visible text block that was omitted from its batch.
    for (const message of normalizedMessages) {
      for (const part of storedContent(message.contentJson)) {
        if (part.type === 'text' && part.text.length)
          requireThat(blockIds.has(`${message.id}:${part.blockIndex}`));
      }
    }
    return { session, messages: normalizedMessages, blocks: normalizedBlocks };
  }
  async function sync(input: unknown): Promise<SyncResult> {
    ready();
    const batch = await normalize(input);
    const previous = await checkBatch(batch);
    if (
      !batch.messages.length &&
      !batch.blocks.length &&
      previous &&
      sessionSchema.fields.every(
        (field) => fieldOf(previous, field.name) === fieldOf(batch.session, field.name),
      )
    ) {
      return { session: previous, messages: 0, blocks: 0, changed: false };
    }
    const name = `${String(Date.now()).padStart(16, '0')}-${randomUUID()}.json`;
    try {
      const target = resolve(journalDirectory, name);
      const temporary = `${target}.pending`;
      requireThat(
        dirname(target) === resolve(journalDirectory) && temporary === `${target}.pending`,
      );
      // An incomplete file never has the recoverable .json suffix. Only publish
      // a fully flushed intent before touching the tables; orphan .pending is harmless.
      await durableNew(temporary, JSON.stringify(batch));
      await rename(temporary, target);
      await failureHook?.('afterJournal');
      await apply(batch, failureHook);
      await durableNew(join(journalDirectory, `${name}.done`), 'done\n');
    } catch (cause) {
      interrupted = true;
      throw cause;
    }
    return {
      session: batch.session,
      messages: batch.messages.length,
      blocks: batch.blocks.length,
      changed: true,
    };
  }
  async function checkpoints({ sessionIds }: CheckpointsRequest = {}): Promise<CheckpointsResult> {
    ready();
    const ids = sessionIds === undefined ? undefined : idsOf(sessionIds);
    let query = sessionsTable.query();
    if (ids) query = query.where(inList('sessionId', ids));
    return {
      sessions: await rowsOf<SessionRow>(
        query.orderBy({ columnName: 'sessionId', ascending: true }),
      ),
    };
  }
  async function pendingRows(
    sessionIds: string[],
    visit?: (row: PendingMetadata) => void | Promise<void>,
    where = inList('sessionId', sessionIds),
  ): Promise<PendingState> {
    // Only small metadata batches are retained; a block's original text is loaded on demand.
    const query = blocks.query().select(['id', 'sessionId', 'textHash']).where(where);
    let pending = 0,
      completedChunks = 0;
    for await (const arrowBatch of query) {
      const metadata = await rowsOf<PendingMetadata>(arrowBatch);
      for (let offset = 0; offset < metadata.length; offset += 128) {
        const group = metadata.slice(offset, offset + 128);
        const completed = await lookup<ProgressRow, 'id'>(progress, 'id', group.map(progressId));
        for (const row of group) {
          const done = completed.get(progressId(row));
          if (
            done &&
            done.spaceId === (space?.spaceId ?? embedder?.spaceId ?? done.spaceId) &&
            done.chunkingVersion === CHUNKING_VERSION &&
            done.textHash === row.textHash
          ) {
            completedChunks += done.chunks;
          } else {
            pending++;
            await visit?.(row);
          }
        }
      }
    }
    return { pending, completedChunks };
  }
  async function ensureVectors(dimensions: number, configured: Embedder): Promise<Table> {
    if (space) requireThat(space.dimensions === dimensions, 'EMBEDDING_CONFIG_CHANGED');
    else {
      const nextSpace: SpaceRow = { id: 'current', spaceId: configured.spaceId, dimensions };
      await upsert(spaces, [nextSpace]);
      space = nextSpace;
    }
    if (!vectors) {
      vectors = await table('vectors', vectorSchema(dimensions));
      await ensureIndex(vectors, 'sessionId', lance.Index.btree());
      await ensureIndex(vectors, 'blockId', lance.Index.btree());
    }
    return vectors;
  }
  async function embed({ sessionIds }: EmbedRequest = {}): Promise<EmbedResult> {
    ready();
    const configured = embeddingReady();
    const ids = idsOf(sessionIds);
    let added = 0,
      reused = 0;
    const queued: QueuedChunk[] = [];
    async function flush(): Promise<void> {
      if (!queued.length) return;
      const result = await configured.embed(queued.map((item) => item.text));
      const dimensions = vectorsValid(result, queued.length, space?.dimensions);
      const vectorTable = await ensureVectors(dimensions, configured);
      // Each successful remote batch is committed before another one is sent.
      await upsert(
        vectorTable,
        queued.map((item, index) => ({ ...item.row, vector: result[index] })),
        'chunkId',
      );
      added += queued.length;
      const completed: ProgressRow[] = [];
      for (const item of queued) {
        if (--item.completion.remaining === 0) completed.push(item.completion.row);
      }
      await upsert(progress, completed);
      queued.length = 0;
    }
    const state = await pendingRows(ids, async (metadata) => {
      const block = (
        await rowsOf<IndexedBlock>(
          blocks
            .query()
            .where(`id = ${sql(metadata.id)}`)
            .limit(1),
        )
      )[0];
      const parts = chunkText(block.text);
      const existing = vectors
        ? new Set(
            (
              await rowsOf<Pick<VectorRow, 'chunkId'>>(
                vectors
                  .query()
                  .where(
                    `blockId = ${sql(block.id)} AND spaceId = ${sql(configured.spaceId)} AND chunkingVersion = ${sql(CHUNKING_VERSION)} AND textHash = ${sql(block.textHash)}`,
                  )
                  .select(['chunkId']),
              )
            ).map((row) => row.chunkId),
          )
        : new Set<string>();
      const missing = parts.filter(
        (part) => !existing.has(chunkId(block, part, configured.spaceId)),
      );
      reused += parts.length - missing.length;
      const completion: Completion = {
        remaining: missing.length,
        row: {
          id: progressId(block),
          blockId: block.id,
          sessionId: block.sessionId,
          textHash: block.textHash,
          chunkingVersion: CHUNKING_VERSION,
          spaceId: configured.spaceId,
          chunks: parts.length,
        },
      };
      if (!missing.length) await upsert(progress, [completion.row]);
      for (const part of missing) {
        queued.push({
          text: part.text,
          completion,
          row: {
            chunkId: chunkId(block, part, configured.spaceId),
            blockId: block.id,
            messageId: block.messageId,
            sessionId: block.sessionId,
            origin: block.origin,
            role: block.role,
            time: block.time,
            eventSeq: block.eventSeq,
            blockIndex: block.blockIndex,
            textHash: block.textHash,
            dedupKey: block.dedupKey,
            chunkingVersion: CHUNKING_VERSION,
            spaceId: configured.spaceId,
            start: part.start,
            end: part.end,
          },
        });
        if (queued.length === EMBED_BATCH) await flush();
      }
    });
    await flush();
    reused += state.completedChunks;
    return {
      new: added,
      reused,
      remaining: 0,
      remainingUnit: 'blocks',
      spaceId: space?.spaceId ?? null,
    };
  }
  function searchParams(input: unknown): SearchRequest {
    requireThat(record(input));
    const { query, mode, role, from, to, cursor, binding } = input;
    requireThat(
      string(query) &&
        query.length > 0 &&
        (mode === 'exact' || mode === 'fuzzy' || mode === 'semantic'),
    );
    requireThat(
      role === undefined ||
        role === 'user' ||
        role === 'assistant' ||
        role === 'system' ||
        role === 'tool',
    );
    requireThat(
      (from === undefined || finite(from)) &&
        (to === undefined || finite(to)) &&
        (from === undefined || to === undefined || from <= to),
    );
    requireThat(binding !== undefined && binding !== null);
    requireThat(cursor === undefined || string(cursor), 'INVALID_CURSOR');
    const limit = input.limit;
    requireThat(limit === undefined || integer(limit, 1, 20));
    const sessionIds = idsOf(input.sessionIds);
    requireThat(string(binding));
    return {
      query,
      mode,
      sessionIds,
      role,
      from,
      to,
      limit,
      cursor,
      binding: JSON.stringify({
        caller: binding,
        query,
        mode,
        sessionIds,
        role: role ?? null,
        from: from ?? null,
        to: to ?? null,
      }),
    };
  }
  async function lexical(params: SearchRequest): Promise<CandidateResult> {
    const { query, mode } = params;
    const scope = scopeWhere(params);
    const terms = [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
    requireThat(mode !== 'fuzzy' || terms.length > 0);
    let selection = blocks
      .query()
      .where(mode === 'exact' ? `${scope} AND strpos(text, ${sql(query)}) > 0` : scope);
    // Exact is a literal scan: tokenizer normalization must never remove a hit.
    if (mode === 'fuzzy')
      selection = selection.fullTextSearch(
        new lance.MatchQuery(query, 'text', { operator: lance.Operator.Or }),
      );
    if (mode === 'exact') selection = selection.orderBy(order);
    // LIMIT occurs after the hard scope and, for exact, original full-block verification.
    const raw = await rowsOf<LexicalRow>(selection.limit(CAP + 1));
    const unique = new Map<string, SearchHit>();
    for (const row of raw.slice(0, CAP)) {
      const matchedTerms =
        mode === 'fuzzy' ? terms.filter((term) => row.text.includes(term)) : undefined;
      if (mode === 'exact' && !row.text.includes(query)) continue;
      if (mode === 'fuzzy' && !matchedTerms!.length) continue;
      const start =
        mode === 'exact'
          ? row.text.indexOf(query)
          : Math.min(...matchedTerms!.map((term) => row.text.indexOf(term)));
      const hit: SearchHit = {
        ...hitOf(row, row.text, start),
        ...(mode === 'exact' ? { matchStart: start, matchEnd: start + query.length } : {}),
        ...(mode === 'fuzzy'
          ? {
              matchedTerms,
              coverage: matchedTerms!.length / terms.length,
              score: Number(row._score ?? 0),
              bm25: Number(row._score ?? 0),
            }
          : {}),
      };
      const old = unique.get(row.dedupKey);
      if (!old || stable(hit, old) < 0) unique.set(row.dedupKey, hit);
    }
    const hits = [...unique.values()];
    hits.sort(
      mode === 'exact'
        ? stable
        : (a, b) => b.coverage! - a.coverage! || b.score! - a.score! || stable(a, b),
    );
    return {
      hits,
      candidateTruncated: raw.length > CAP,
      coverage: {
        method: mode === 'exact' ? 'full-block-substring' : 'query-term-coverage-then-bm25',
        candidateLimit: CAP,
        examinedCandidates: Math.min(CAP, raw.length),
        exhaustive: raw.length <= CAP,
        ...(mode === 'fuzzy' ? { terms } : {}),
      },
    };
  }
  async function semantic(params: SearchRequest): Promise<CandidateResult> {
    const configured = embeddingReady();
    const blockCount = await blocks.countRows(scopeWhere(params));
    if (!blockCount)
      return {
        hits: [],
        candidateTruncated: false,
        coverage: {
          method: 'exact-flat-cosine',
          rerank: 'exact-cosine',
          scopeChunks: 0,
          exhaustive: true,
          candidateLimit: CAP,
        },
      };
    requireThat(space && vectors, 'EMBEDDING_NOT_READY');
    const where = `${scopeWhere(params)} AND spaceId = ${sql(space.spaceId)} AND chunkingVersion = ${sql(CHUNKING_VERSION)}`;
    const scopeChunks = await vectors.countRows(where);
    requireThat(scopeChunks > 0, 'EMBEDDING_NOT_READY');
    const result = await configured.embed([params.query]);
    vectorsValid(result, 1, space.dimensions);
    const queryVector = result[0];
    const flat = scopeChunks <= FLAT_MAX;
    if (!flat) {
      await ensureIndex(
        vectors,
        'vector',
        lance.Index.ivfFlat({
          distanceType: 'cosine',
          numPartitions: Math.max(1, Math.min(256, Math.floor((await vectors.countRows()) / 256))),
        }),
      );
    }
    let selected: VectorRow[];
    if (flat) selected = await rowsOf<VectorRow>(vectors.query().where(where).limit(FLAT_MAX));
    else
      selected = await rowsOf<VectorRow>(
        vectors
          .vectorSearch(queryVector)
          .distanceType('cosine')
          .where(where)
          .nprobes(32)
          .limit(CAP),
      ); // LanceDB vector search prefilters by default.
    const best = new Map<string, RankedVector>();
    for (const row of selected) {
      const hit: RankedVector = { ...row, similarity: cosine(queryVector, Array.from(row.vector)) };
      const prior = best.get(row.dedupKey);
      if (
        !prior ||
        hit.similarity > prior.similarity ||
        (hit.similarity === prior.similarity && stable(hit, prior) < 0)
      )
        best.set(row.dedupKey, hit);
    }
    const ranked = [...best.values()].sort((a, b) => b.similarity - a.similarity || stable(a, b));
    const hits: SearchHit[] = [];
    // Read only each returned block, never a whole source corpus into JS memory.
    for (const row of ranked.slice(0, CAP)) {
      const block = (
        await rowsOf<IndexedBlock>(
          blocks
            .query()
            .where(`id = ${sql(row.blockId)}`)
            .limit(1),
        )
      )[0];
      if (block && block.textHash === row.textHash)
        hits.push({ ...hitOf(row, block.text, row.start, row.end), similarity: row.similarity });
    }
    const pending = (await pendingRows(params.sessionIds, undefined, scopeWhere(params))).pending;
    return {
      hits,
      candidateTruncated: ranked.length > CAP || (!flat && scopeChunks > selected.length),
      coverage: {
        method: flat ? 'exact-flat-cosine' : 'ivf-flat-candidates',
        rerank: 'exact-cosine',
        scopeChunks,
        examinedCandidates: selected.length,
        candidateLimit: CAP,
        pendingBlocks: pending,
        exhaustive: flat && ranked.length <= CAP && pending === 0,
        annExhaustive: flat,
      },
    };
  }
  async function search(input: unknown): Promise<SearchResult> {
    ready();
    const params = searchParams(input);
    // Snapshot continuation deliberately precedes all embedding/config/index work.
    if (params.cursor !== undefined)
      return pages.next({ cursor: params.cursor, binding: params.binding, limit: params.limit });
    const result = params.mode === 'semantic' ? await semantic(params) : await lexical(params);
    const presentation = chooseCandidates(result.hits, {
      ...candidatePolicy,
      mode: params.mode,
      limit: params.limit,
    });
    return pages.create({
      binding: params.binding,
      hits: result.hits,
      pageSize: Math.max(1, presentation.count),
      presentation,
      meta: { coverage: result.coverage, candidateTruncated: result.candidateTruncated },
    });
  }
  async function read({
    ref,
    blockIndex = 0,
    offset = 0,
    length = 4000,
    before = 1,
    after = 1,
  }: Partial<ReadRequest> = {}): Promise<ReadResult> {
    ready();
    requireThat(
      string(ref) &&
        ref.length > 0 &&
        integer(blockIndex) &&
        integer(offset) &&
        integer(length, 1, 12000) &&
        integer(before, 0, 3) &&
        integer(after, 0, 3),
    );
    const target = (
      await rowsOf<StoredMessage>(
        messages
          .query()
          .where(`id = ${sql(ref)}`)
          .limit(1),
      )
    )[0];
    requireThat(target, 'NOT_FOUND');
    const content = storedContent(target.contentJson);
    const part = content.find((item) => item.blockIndex === blockIndex);
    const attachmentOnly = !content.some((item) => item.type === 'text');
    requireThat(attachmentOnly || part?.type === 'text', 'NOT_FOUND');
    const text = attachmentOnly ? null : part!.text!;
    requireThat(offset <= (text?.length ?? 0));
    const start = text === null ? 0 : safeStart(text, offset);
    let end = text === null ? 0 : safeEnd(text, Math.min(text.length, start + length));
    // A one-unit request at an astral character must still make forward progress.
    if (text !== null && end === start && start < text.length)
      end = Math.min(text.length, start + 2);
    const earlier = before
      ? (
          await rowsOf<StoredMessage>(
            messages
              .query()
              .where(`sessionId = ${sql(target.sessionId)} AND eventSeq < ${target.eventSeq}`)
              .orderBy({ columnName: 'eventSeq', ascending: false })
              .limit(before),
          )
        ).reverse()
      : [];
    const later = after
      ? await rowsOf<StoredMessage>(
          messages
            .query()
            .where(`sessionId = ${sql(target.sessionId)} AND eventSeq > ${target.eventSeq}`)
            .orderBy({ columnName: 'eventSeq', ascending: true })
            .limit(after),
        )
      : [];
    const context: ContextMessage[] = [...earlier, ...later].map((row) => {
      let budget = 4000;
      const bounded = storedContent(row.contentJson).map((item): VisibleBlock => {
        if (item.type !== 'text') return item;
        const text = boundedText(item.text, budget);
        budget -= text.length;
        return {
          type: 'text',
          blockIndex: item.blockIndex,
          text,
          truncated: text.length < item.text.length,
        };
      });
      return { ref: row.id, eventSeq: row.eventSeq, role: row.role, content: bounded };
    });
    return {
      ref,
      sessionId: target.sessionId,
      eventSeq: target.eventSeq,
      blockIndex,
      role: target.role,
      time: target.time,
      text: text === null ? null : text.slice(start, end),
      textHash: text === null ? null : digest(text),
      offset: start,
      nextOffset: text !== null && end < text.length ? end : null,
      totalLength: text?.length ?? 0,
      attachments: content.filter((item) => item.type !== 'text'),
      context,
    };
  }
  async function sessions({
    sessionIds,
    query,
    offset = 0,
    limit = 20,
  }: SessionsRequest = {}): Promise<SessionsResult> {
    ready();
    const ids = idsOf(sessionIds);
    requireThat(
      (query === undefined || string(query)) && integer(offset) && integer(limit, 1, 100),
    );
    const where = `${inList('sessionId', ids)}${query ? ` AND (strpos(title, ${sql(query)}) > 0 OR strpos(sessionId, ${sql(query)}) > 0)` : ''}`;
    const total = await sessionsTable.countRows(where);
    const rows = await rowsOf<SessionRow>(
      sessionsTable
        .query()
        .where(where)
        .orderBy([
          { columnName: 'updatedAt', ascending: false },
          { columnName: 'sessionId', ascending: true },
        ])
        .offset(offset)
        .limit(limit),
    );
    return {
      sessions: rows,
      total,
      offset,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  async function status(): Promise<StoreStatus> {
    ready();
    const checkpointsResult = await checkpoints();
    const pending = await pendingRows(
      checkpointsResult.sessions.map((session) => session.sessionId),
    );
    return {
      counts: {
        sessions: checkpointsResult.sessions.length,
        messages: await messages.countRows(),
        blocks: await blocks.countRows(),
        vectors: vectors ? await vectors.countRows() : 0,
      },
      checkpoints: checkpointsResult.sessions,
      embedding: {
        configured: Boolean(embedder),
        spaceId: space?.spaceId ?? null,
        dimensions: space?.dimensions ?? null,
        status:
          space && embedder && space.spaceId !== embedder.spaceId
            ? 'config-changed'
            : !embedder
              ? 'not-configured'
              : pending.pending
                ? 'pending'
                : 'ready',
        chunkingVersion: CHUNKING_VERSION,
        pendingBlocks: pending.pending,
        completedChunks: pending.completedChunks,
      },
      pending: pending.pending,
      pendingUnit: 'blocks',
    };
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const target of Object.values(tables)) target.close();
    db.close();
  }
  return { sync, checkpoints, embed, search, read, sessions, status, close };
}
