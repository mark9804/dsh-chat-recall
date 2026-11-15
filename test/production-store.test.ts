import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lance from '@lancedb/lancedb';
import { openStore } from '../dist/storage/store.js';
import type { OpenStoreOptions } from '../dist/storage/store.js';
import { chunkText, CHUNKING_VERSION } from '../dist/core/chunking.js';
import type {
  BlockRow,
  MessageRow,
  SearchHit,
  SearchMode,
  SyncBatch,
  VisibleBlock,
} from '../dist/shared/model.js';

const rejects = (code: string) => (value: unknown) => {
  assert.ok(value instanceof Error && 'code' in value);
  assert.equal(value.code, code);
  return true;
};
interface BatchEntry {
  seq: number;
  text?: string;
  role?: string;
  sourceMessageId?: string;
  blockIndex?: number;
  attachments?: VisibleBlock[];
}
interface BatchOptions {
  cursor?: number;
  title?: string;
  updatedAt?: number;
}
function batch(
  sessionId = 'synthetic',
  entries: BatchEntry[] = [],
  options: BatchOptions = {},
): SyncBatch {
  const messages: MessageRow[] = [],
    blocks: BlockRow[] = [];
  for (const entry of entries) {
    const { seq, text, role = 'user', sourceMessageId, blockIndex = 0, attachments = [] } = entry;
    const id = `${sessionId}:${seq}`;
    const content = [...attachments];
    if (text !== undefined)
      content.push({
        type: 'text',
        text,
        blockIndex,
        ...(sourceMessageId ? { originalMessageId: sourceMessageId, inherited: true } : {}),
      });
    messages.push({
      id,
      sessionId,
      title: 'Synthetic title',
      cwd: '/synthetic',
      origin: 'main',
      archived: false,
      eventSeq: seq,
      time: seq * 1000,
      role,
      contentJson: JSON.stringify(content),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
    if (text !== undefined && text.length)
      blocks.push({
        id: `${id}:${blockIndex}`,
        messageId: id,
        sessionId,
        origin: 'main',
        role,
        time: seq * 1000,
        eventSeq: seq,
        blockIndex,
        text,
      });
  }
  const cursor = options.cursor ?? Math.max(-1, ...entries.map((entry) => entry.seq));
  return {
    session: {
      sessionId,
      title: options.title ?? 'Synthetic title',
      cwd: '/synthetic',
      origin: 'main',
      createdAt: 1,
      inheritedEventCount: 0,
      cursor,
      anchorHash: `anchor-${cursor}`,
      updatedAt: options.updatedAt ?? 100,
    },
    messages,
    blocks,
  };
}
async function fixture(t: TestContext, options: OpenStoreOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-store-test-'));
  const store = await openStore({ root, ...options });
  t.after(() => store.close());
  return { root, store };
}
interface FakeEmbedderOptions {
  spaceId?: string;
  vector?: (text: string, index: number) => number[];
  failCall?: number;
}
function fakeEmbedder({
  spaceId = 'synthetic-space',
  vector = () => [1, 0],
  failCall,
}: FakeEmbedderOptions = {}) {
  const calls: string[][] = [];
  return {
    spaceId,
    calls,
    async embed(texts: string[]) {
      calls.push([...texts]);
      if (calls.length === failCall)
        throw Object.assign(new Error('synthetic failure'), { code: 'NETWORK_ERROR' });
      return texts.map(vector);
    },
  };
}
const query = (text: string, mode: SearchMode = 'exact', more: Record<string, unknown> = {}) => ({
  query: text,
  mode,
  sessionIds: ['synthetic'],
  binding: 'synthetic-caller',
  ...more,
});

// These tests create only fresh synthetic temporary databases; no real logs, credentials,
// network, recursive cleanup or arbitrary user-file removal is involved.
test('sync is explicit, zero-indexed, idempotent and empty deltas do not journal again', async (t) => {
  const { root, store } = await fixture(t);
  await store.sync(batch('synthetic', [], { cursor: -1 }));
  assert.equal((await store.checkpoints()).sessions[0].cursor, -1);
  const source = batch('synthetic', [{ seq: 0, text: 'First synthetic text.' }]);
  await store.sync(source);
  await store.sync(source);
  assert.deepEqual((await store.status()).counts, {
    sessions: 1,
    messages: 1,
    blocks: 1,
    vectors: 0,
  });
  const before = await readdir(join(root, 'journals'));
  const noChange = await store.sync(batch('synthetic', [], { cursor: 0 }));
  assert.equal(noChange.changed, false);
  assert.deepEqual(await readdir(join(root, 'journals')), before);
  assert.deepEqual(
    (await store.search(query('synthetic'))).hits.map((hit) => hit.ref),
    ['synthetic:0'],
  );
  assert.equal((await store.status()).embedding.status, 'not-configured');
  await assert.rejects(store.embed({ sessionIds: ['synthetic'] }), rejects('NO_EMBEDDING_CONFIG'));
  await assert.rejects(store.search(query('query', 'semantic')), rejects('NO_EMBEDDING_CONFIG'));
});

for (const stage of ['afterJournal', 'afterMessages', 'afterBlocks', 'afterCheckpoint']) {
  test(`journal recovers ${stage}, checkpoints last, rejects reads until reopened`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-production-recovery-${stage}-`));
    const store = await openStore({
      root,
      failureHook: (current) => {
        if (current === stage) throw new Error(stage);
      },
    });
    const data = batch('synthetic', [{ seq: 0, text: `Synthetic ${stage} recovery` }]);
    await assert.rejects(store.sync(data), new RegExp(stage));
    for (const operation of [
      () => store.search(query('recovery')),
      () => store.checkpoints(),
      () => store.status(),
    ]) {
      await assert.rejects(operation(), rejects('SYNC_INCOMPLETE'));
    }
    await store.close();
    const db = await lance.connect(join(root, 'db'));
    const checkpoints = await db.openTable('sessions');
    assert.equal(await checkpoints.countRows(), stage === 'afterCheckpoint' ? 1 : 0);
    checkpoints.close();
    db.close();
    const reopened = await openStore({ root });
    t.after(() => reopened.close());
    assert.equal((await reopened.checkpoints()).sessions[0].cursor, 0);
    assert.deepEqual((await reopened.status()).counts, {
      sessions: 1,
      messages: 1,
      blocks: 1,
      vectors: 0,
    });
    await reopened.sync(data);
    assert.equal((await reopened.search(query('recovery'))).hits.length, 1);
    assert.equal(
      (await readdir(join(root, 'journals'))).filter((name) => name.endsWith('.done')).length,
      2,
    );
  });
}

test('completed journals are skipped instead of replaying or parsing their old payloads', async (t) => {
  const { root, store } = await fixture(t);
  await store.sync(batch('synthetic', [{ seq: 0, text: 'Retain completed data' }]));
  await store.close();
  const name = (await readdir(join(root, 'journals'))).find((name) => name.endsWith('.json'));
  assert.ok(name);
  // Deliberate corruption is confined to this test's newly created synthetic file.
  await writeFile(join(root, 'journals', name), '{not read after done');
  await writeFile(join(root, 'journals', 'orphan.json.pending'), '{torn unpublished intent');
  const reopened = await openStore({ root });
  t.after(() => reopened.close());
  assert.equal((await reopened.search(query('completed'))).hits.length, 1);
});

test('immutable source rejects changed content, backward checkpoint, changed anchor and old unseen IDs', async (t) => {
  const { store } = await fixture(t);
  await store.sync(batch('synthetic', [{ seq: 1, text: 'Immutable content' }], { cursor: 2 }));
  await assert.rejects(
    store.sync(batch('synthetic', [{ seq: 1, text: 'Changed content' }], { cursor: 2 })),
    rejects('SOURCE_CHANGED'),
  );
  const blockOnlyChange = batch('synthetic', [{ seq: 1, text: 'Changed block only' }], {
    cursor: 2,
  });
  blockOnlyChange.messages = [];
  await assert.rejects(store.sync(blockOnlyChange), rejects('SOURCE_CHANGED'));
  await assert.rejects(
    store.sync(batch('synthetic', [], { cursor: 1 })),
    rejects('SOURCE_CHANGED'),
  );
  const changedAnchor = batch('synthetic', [], { cursor: 2 });
  changedAnchor.session.anchorHash = 'changed';
  await assert.rejects(store.sync(changedAnchor), rejects('SOURCE_CHANGED'));
  await assert.rejects(
    store.sync(batch('synthetic', [{ seq: 0, text: 'Previously absent old row' }], { cursor: 2 })),
    rejects('SOURCE_CHANGED'),
  );
  assert.equal((await store.search(query('Immutable'))).hits.length, 1);
});

test('full-block exact crosses chunk boundaries, scans whitespace, filters scope and role before limit', async (t) => {
  const { store } = await fixture(t);
  const text = '甲'.repeat(599) + '跨越边界🐳关键字' + '乙'.repeat(800);
  const split = chunkText(text);
  assert.ok(split.length > 1);
  const cross = text.slice(split[0].end - 4, split[0].end + 6);
  await store.sync(
    batch('synthetic', [
      { seq: 0, text },
      { seq: 1, text: 'alpha  beta', role: 'assistant' },
      { seq: 2, text: 'alpha beta', role: 'user' },
    ]),
  );
  await store.sync(batch('foreign', [{ seq: 0, text: 'alpha  beta' }]));
  const exact = await store.search(query(cross));
  assert.equal(exact.hits[0].ref, 'synthetic:0');
  assert.equal(exact.hits[0].textHash.length, 64);
  assert.ok(text.includes(exact.hits[0].excerpt));
  const blank = await store.search(query('  '));
  assert.deepEqual(
    blank.hits.map((hit) => hit.ref),
    ['synthetic:1'],
  );
  const scoped = await store.search(
    query('alpha', 'exact', { role: 'user', limit: 1, from: 1500, to: 2500 }),
  );
  assert.deepEqual(
    scoped.hits.map((hit) => hit.ref),
    ['synthetic:2'],
  );
  assert.equal((await store.search(query('alpha', 'exact', { sessionIds: [] }))).hits.length, 0);
});

test('identity dedup merges inherited source+role+block+hash, not independent equal text', async (t) => {
  const { store } = await fixture(t);
  const text = 'Repeated synthetic statement';
  await store.sync(
    batch('synthetic', [
      { seq: 0, text, sourceMessageId: 'original-shared' },
      { seq: 1, text },
      { seq: 2, text, sourceMessageId: 'original-shared', role: 'assistant' },
      { seq: 3, text, sourceMessageId: 'original-shared', blockIndex: 2 },
      { seq: 4, text: `${text} modified`, sourceMessageId: 'original-shared' },
    ]),
  );
  await store.sync(batch('fork', [{ seq: 0, text, sourceMessageId: 'original-shared' }]));
  const result = await store.search(
    query('Repeated', 'exact', { sessionIds: ['synthetic', 'fork'], limit: 10 }),
  );
  assert.equal(result.totalCandidates, 5);
  assert.equal(result.hits.filter((hit) => hit.ref === 'synthetic:1').length, 1);
  assert.equal(result.hits.filter((hit) => hit.role === 'assistant').length, 1);
  assert.equal(result.hits.filter((hit) => hit.blockIndex === 2).length, 1);
});

test('fuzzy ranks complete query-term coverage ahead of BM25 and discloses scoring', async (t) => {
  const { store } = await fixture(t);
  await store.sync(
    batch('synthetic', [
      { seq: 0, text: '鲸鱼 鲸鱼 鲸鱼' },
      { seq: 1, text: '蓝色鲸鱼喜欢海洋' },
      { seq: 2, text: '海洋 海洋' },
      { seq: 3, text: 'completely unrelated' },
    ]),
  );
  const result = await store.search(query('鲸鱼 海洋', 'fuzzy', { limit: 10 }));
  assert.equal(result.hits[0].ref, 'synthetic:1');
  assert.equal(result.hits[0].coverage, 1);
  assert.deepEqual(result.hits[0].matchedTerms, ['鲸鱼', '海洋']);
  assert.ok(Number.isFinite(result.hits[0].score));
  assert.equal(result.hits[0].similarity, undefined);
  assert.equal(result.coverage.method, 'query-term-coverage-then-bm25');
  const reversed = await store.search(query('海洋 鲸鱼', 'fuzzy', { limit: 10 }));
  assert.deepEqual(
    reversed.hits.map((hit) => hit.ref),
    result.hits.map((hit) => hit.ref),
  );
  assert.deepEqual(
    reversed.hits.map((hit) => hit.bm25),
    result.hits.map((hit) => hit.bm25),
  );
});

test('progress BTree covers successful batches and append, repairs legacy missing index, avoids idle rebuild', async (t) => {
  const embedder = fakeEmbedder();
  const { root, store } = await fixture(t, { embedder });
  await store.sync(
    batch(
      'synthetic',
      Array.from({ length: 65 }, (_, seq) => ({ seq, text: `initial ${seq}` })),
    ),
  );
  await store.embed({ sessionIds: ['synthetic'] });
  const inspect = async () => {
    const db = await lance.connect(join(root, 'db'));
    const table = await db.openTable('embedding_progress');
    try {
      const index = (await table.listIndices()).find((x) => x.columns.includes('id'));
      return { index, stats: index ? await table.indexStats(index.name) : undefined };
    } finally {
      table.close();
      db.close();
    }
  };
  const first = await inspect();
  assert.equal(first.index?.indexType, 'BTree');
  assert.equal(first.stats?.numIndexedRows, 65);
  assert.equal(first.stats?.numUnindexedRows, 0);
  await store.sync(batch('synthetic', [{ seq: 65, text: 'new assistant', role: 'assistant' }]));
  const pending = await store.search(query('query', 'semantic', { role: 'user' }));
  assert.equal(pending.coverage.pendingBlocks, 0);
  assert.equal((await store.status()).embedding.pendingBlocks, 1);
  await store.embed({ sessionIds: ['synthetic'] });
  const second = await inspect();
  assert.equal(second.stats?.numIndexedRows, 66);
  assert.equal(second.stats?.numUnindexedRows, 0);
  assert.notEqual(second.index?.indexUuid, first.index?.indexUuid);
  const calls = embedder.calls.length;
  assert.equal((await store.embed({ sessionIds: ['synthetic'] })).new, 0);
  assert.equal(embedder.calls.length, calls);
  assert.equal((await inspect()).index?.indexUuid, second.index?.indexUuid);
  await store.close();
  const db = await lance.connect(join(root, 'db'));
  const table = await db.openTable('embedding_progress');
  try {
    await table.dropIndex(second.index!.name);
  } finally {
    table.close();
    db.close();
  }
  const reopened = await openStore({ root, embedder });
  t.after(() => reopened.close());
  assert.equal((await reopened.status()).embedding.pendingBlocks, 0);
  assert.equal((await inspect()).stats?.numIndexedRows, 66);
});

test('partial embedding commits regain progress index after failure and resume only missing vectors', async (t) => {
  const embedder = fakeEmbedder({ failCall: 2 });
  const { root, store } = await fixture(t, { embedder });
  await store.sync(
    batch(
      'synthetic',
      Array.from({ length: 40 }, (_, seq) => ({ seq, text: `resume ${seq}` })),
    ),
  );
  await assert.rejects(store.embed({ sessionIds: ['synthetic'] }), rejects('NETWORK_ERROR'));
  assert.equal((await store.status()).embedding.pendingBlocks, 8);
  const db = await lance.connect(join(root, 'db'));
  const progress = await db.openTable('embedding_progress');
  try {
    const index = (await progress.listIndices()).find((x) => x.columns.includes('id'))!;
    assert.equal((await progress.indexStats(index.name))?.numUnindexedRows, 0);
  } finally {
    progress.close();
    db.close();
  }
  const result = await store.embed({ sessionIds: ['synthetic'] });
  assert.equal(result.new, 8);
  assert.equal(result.reused, 32);
  assert.equal(result.remaining, 0);
});

test('embedding is explicit and incremental across reopen; metadata-only sync sends no text', async (t) => {
  const embedder = fakeEmbedder();
  const { root, store } = await fixture(t, { embedder });
  await store.sync(batch('synthetic', [{ seq: 0, text: 'First vector document' }]));
  assert.equal(embedder.calls.length, 0);
  assert.equal((await store.status()).pending, 1);
  const first = await store.embed({ sessionIds: ['synthetic'] });
  assert.equal(first.new, 1);
  assert.equal(first.reused, 0);
  await store.sync(batch('synthetic', [], { cursor: 0, title: 'Updated title', updatedAt: 101 }));
  assert.equal((await store.embed({ sessionIds: ['synthetic'] })).new, 0);
  assert.equal(embedder.calls.length, 1);
  await store.sync(
    batch('synthetic', [{ seq: 1, text: 'Second vector document' }], { updatedAt: 102 }),
  );
  assert.equal((await store.embed({ sessionIds: ['synthetic'] })).new, 1);
  await store.close();
  const reopened = await openStore({ root, embedder });
  t.after(() => reopened.close());
  const reuse = await reopened.embed({ sessionIds: ['synthetic'] });
  assert.equal(reuse.new, 0);
  assert.equal(reuse.reused, 2);
  assert.equal(reuse.remaining, 0);
  assert.equal(embedder.calls.length, 2);
  assert.equal((await reopened.status()).embedding.chunkingVersion, CHUNKING_VERSION);
  assert.equal(
    (await readdir(root)).some((name) => name.includes('outbound')),
    false,
  );
});

test('failed embedding preserves committed vectors and resumes missing chunks without resubmitting them', async (t) => {
  const embedder = fakeEmbedder({ failCall: 2 });
  const { root, store } = await fixture(t, { embedder });
  const text = Array.from(
    { length: 70 },
    (_, index) => `Part ${index}: ` + String.fromCharCode(65 + (index % 26)).repeat(590),
  ).join('\n\n');
  const parts = chunkText(text);
  assert.ok(parts.length > 32);
  await store.sync(batch('synthetic', [{ seq: 0, text }]));
  await assert.rejects(store.embed({ sessionIds: ['synthetic'] }), rejects('NETWORK_ERROR'));
  const status = await store.status();
  assert.equal(status.counts.vectors, 32);
  assert.equal(status.pending, 1);
  assert.equal((await store.search(query('Part 0:'))).hits.length, 1);
  await store.close();
  const resumed = fakeEmbedder();
  const reopened = await openStore({ root, embedder: resumed });
  t.after(() => reopened.close());
  const result = await reopened.embed({ sessionIds: ['synthetic'] });
  assert.equal(result.reused, 32);
  assert.equal(result.new, parts.length - 32);
  assert.deepEqual(
    resumed.calls.flat(),
    parts.slice(32).map((part) => part.text),
  );
  assert.equal((await reopened.status()).counts.vectors, parts.length);
  assert.equal((await reopened.status()).pending, 0);
});

test('model space conflict refuses semantic and embedding but preserves vectors and lexical access', async (t) => {
  const { root, store } = await fixture(t, { embedder: fakeEmbedder({ spaceId: 'space-a' }) });
  await store.sync(batch('synthetic', [{ seq: 0, text: 'Existing model vector' }]));
  await store.embed({ sessionIds: ['synthetic'] });
  await store.close();
  const next = fakeEmbedder({ spaceId: 'space-b' });
  const reopened = await openStore({ root, embedder: next });
  t.after(() => reopened.close());
  await assert.rejects(
    reopened.search(query('model', 'semantic')),
    rejects('EMBEDDING_CONFIG_CHANGED'),
  );
  await assert.rejects(
    reopened.embed({ sessionIds: ['synthetic'] }),
    rejects('EMBEDDING_CONFIG_CHANGED'),
  );
  assert.equal((await reopened.search(query('model'))).hits.length, 1);
  assert.equal((await reopened.search(query('model', 'fuzzy'))).hits.length, 1);
  assert.equal(next.calls.length, 0);
  assert.equal((await reopened.status()).counts.vectors, 1);
  assert.equal((await reopened.status()).embedding.status, 'config-changed');
});

test('semantic scope precedes ranking; adaptive first page preserves all remaining snapshot bodies', async (t) => {
  const embedder = fakeEmbedder({
    vector: (text) =>
      text === 'best' || text === 'query'
        ? [1, 0]
        : text === 'second'
          ? [0.2, Math.sqrt(0.96)]
          : text === 'third'
            ? [0, 1]
            : [-1, 0],
  });
  const { root, store } = await fixture(t, { embedder });
  await store.sync(
    batch('synthetic', [
      { seq: 0, text: 'best' },
      { seq: 1, text: 'second' },
      { seq: 2, text: 'third' },
    ]),
  );
  await store.sync(batch('foreign', [{ seq: 0, text: 'best' }]));
  await store.embed({ sessionIds: ['synthetic', 'foreign'] });
  const before = embedder.calls.length;
  const first = await store.search(query('query', 'semantic'));
  assert.equal(embedder.calls.length, before + 1);
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].ref, 'synthetic:0');
  assert.equal(first.totalCandidates, 3);
  assert.ok(first.nextCursor);
  assert.equal(first.presentation.comparison.top3.length, 3);
  assert.equal(first.coverage.method, 'exact-flat-cosine');
  assert.equal(first.coverage.rerank, 'exact-cosine');
  await store.sync(batch('synthetic', [{ seq: 3, text: 'best' }]));
  const second = await store.search(
    query('query', 'semantic', { cursor: first.nextCursor, limit: 1 }),
  );
  const third = await store.search(
    query('query', 'semantic', { cursor: second.nextCursor, limit: 5 }),
  );
  assert.deepEqual(
    [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.ref),
    ['synthetic:0', 'synthetic:1', 'synthetic:2'],
  );
  assert.equal(third.nextCursor, null);
  assert.equal(embedder.calls.length, before + 1);
  await assert.rejects(
    store.search(query('query', 'semantic', { cursor: first.nextCursor, binding: 'wrong' })),
    rejects('INVALID_CURSOR'),
  );
  await assert.rejects(
    store.search(query('query', 'semantic', { cursor: first.nextCursor, sessionIds: ['foreign'] })),
    rejects('INVALID_CURSOR'),
  );
  await store.close();
  const reopened = await openStore({ root });
  t.after(() => reopened.close());
  await assert.rejects(
    reopened.search(query('query', 'semantic', { cursor: first.nextCursor })),
    rejects('CURSOR_EXPIRED'),
  );
  assert.equal(embedder.calls.length, before + 1);
});

test('semantic bulk source hydration preserves candidate bodies across multiple lookup batches', async (t) => {
  const entries = Array.from({ length: 260 }, (_, seq) => ({ seq, text: `source-${seq}` }));
  const embedder = fakeEmbedder({
    vector: (text) => {
      const seq = text === 'needle' ? 0 : Number(text.slice('source-'.length));
      const angle = seq / 260;
      return [Math.cos(angle), Math.sin(angle)];
    },
  });
  const { store } = await fixture(t, { embedder });
  await store.sync(batch('synthetic', entries));
  await store.embed({ sessionIds: ['synthetic'] });
  const first = await store.search(query('needle', 'semantic', { limit: 20 }));
  const hits = [...first.hits];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await store.search(query('needle', 'semantic', { limit: 20, cursor }));
    hits.push(...page.hits);
    cursor = page.nextCursor;
  }
  assert.equal(first.totalCandidates, 260);
  assert.equal(new Set(hits.map((hit) => hit.ref)).size, 260);
  assert.equal(hits[0].ref, 'synthetic:0');
  for (const hit of hits) assert.equal(hit.excerpt, entries[hit.eventSeq].text);
  assert.ok(
    hits.every((hit, index) => index === 0 || hits[index - 1].similarity! >= hit.similarity!),
  );
  assert.equal(embedder.calls.flat().filter((text) => text === 'needle').length, 1);
});

test('semantic deduplicates source chunks and returns the best matching original substring', async (t) => {
  const text = 'A'.repeat(600) + '\n\n' + 'B'.repeat(600);
  const embedder = fakeEmbedder({ vector: (part) => (part.startsWith('A') ? [0, 1] : [1, 0]) });
  const { store } = await fixture(t, { embedder });
  await store.sync(
    batch('synthetic', [
      { seq: 0, text },
      { seq: 1, text: 'Another document' },
    ]),
  );
  await store.embed({ sessionIds: ['synthetic'] });
  const result = await store.search(query('query', 'semantic', { limit: 5 }));
  assert.equal(result.hits.length, 2);
  assert.ok(result.hits[0].start > 0);
  assert.equal(result.hits[0].similarity, 1);
  assert.ok(result.hits[0].excerpt.startsWith('B'));
  assert.ok(result.hits[0].excerpt.length <= 800);
  for (const hit of result.hits) assert.equal(hit.end - hit.start, hit.excerpt.length);
});

test('read preserves surrogate boundaries, bounded neighbors, attachment-only messages and original block indices', async (t) => {
  const { store } = await fixture(t);
  const text = 'A🐳B𠮷C' + '尾'.repeat(13000);
  await store.sync(
    batch('synthetic', [
      { seq: 0, attachments: [{ type: 'image', blockIndex: 2, url: 'synthetic://image' }] },
      { seq: 1, text, blockIndex: 3, role: 'assistant' },
      {
        seq: 2,
        attachments: [
          { type: 'file', blockIndex: 1, name: 'synthetic.txt', url: 'synthetic://file' },
        ],
      },
      { seq: 3, text: 'last neighbor' },
    ]),
  );
  const result = await store.read({
    ref: 'synthetic:1',
    blockIndex: 3,
    offset: 2,
    length: 1,
    before: 1,
    after: 2,
  });
  assert.equal(result.offset, 1);
  assert.equal(result.text, '🐳');
  assert.equal(result.nextOffset, 3);
  assert.deepEqual(
    result.context.map((item) => item.ref),
    ['synthetic:0', 'synthetic:2', 'synthetic:3'],
  );
  assert.equal(result.context[0].content[0].type, 'image');
  assert.equal(result.context[1].content[0].type, 'file');
  const neighborText = result.context[2].content[0].text;
  assert.ok(typeof neighborText === 'string');
  assert.ok(neighborText.length <= 4000);
  assert.notEqual(result.nextOffset, null);
  const second = await store.read({
    ref: 'synthetic:1',
    blockIndex: 3,
    offset: result.nextOffset!,
    length: 3,
  });
  assert.equal(second.text, 'B𠮷');
  const attachment = await store.read({ ref: 'synthetic:0' });
  assert.equal(attachment.text, null);
  assert.equal(attachment.totalLength, 0);
  assert.ok(attachment.context.length > 0);
  await assert.rejects(
    store.read({ ref: 'synthetic:1', blockIndex: 3, length: 12001 }),
    rejects('INVALID_REQUEST'),
  );
  await assert.rejects(store.read({ ref: 'synthetic:1', blockIndex: 0 }), rejects('NOT_FOUND'));
});

test('candidate pool is capped and disclosed; lexical snapshots remain stable across additions', async (t) => {
  const { store } = await fixture(t);
  await store.sync(
    batch(
      'synthetic',
      Array.from({ length: 1003 }, (_, seq) => ({ seq, text: `cap needle ${seq}` })),
    ),
  );
  const first = await store.search(query('needle', 'exact', { limit: 1 }));
  assert.equal(first.totalCandidates, 1000);
  assert.equal(first.candidateTruncated, true);
  assert.equal(first.coverage.exhaustive, false);
  assert.equal(first.hits[0].ref, 'synthetic:0');
  await store.sync(batch('synthetic', [{ seq: 1003, text: 'cap needle newly added' }]));
  let cursor = first.nextCursor;
  const remaining: SearchHit[] = [];
  while (cursor) {
    const page = await store.search(query('needle', 'exact', { cursor, limit: 20 }));
    remaining.push(...page.hits);
    cursor = page.nextCursor;
  }
  assert.equal(remaining.length, 999);
  const last = remaining.at(-1);
  assert.ok(last);
  assert.equal(last.ref, 'synthetic:999');
  assert.equal(new Set([...first.hits, ...remaining].map((hit) => hit.ref)).size, 1000);
  const listing = await store.sessions({ sessionIds: ['synthetic'], query: 'Synthetic', limit: 1 });
  assert.equal(listing.total, 1);
  assert.equal(listing.sessions[0].cursor, 1003);
  assert.deepEqual((await store.checkpoints({ sessionIds: [] })).sessions, []);
});

test('large semantic scope uses IVF_FLAT, exact reranking and filtered small scopes stay flat', async (t) => {
  const embedder = fakeEmbedder();
  const { root, store } = await fixture(t, { embedder });
  await store.sync(batch('synthetic', [{ seq: 0, text: 'Large scope synthetic block' }]));
  await store.sync(
    batch('small-scope', [{ seq: 0, text: 'Small scope synthetic block', role: 'assistant' }]),
  );
  await store.embed({ sessionIds: ['synthetic', 'small-scope'] });
  await store.close();
  // Seed only synthetic vector rows through the real persisted schema. This avoids
  // 10,000 remote-style requests or 6 MB of repeated plaintext in a scale branch test.
  const db = await lance.connect(join(root, 'db'));
  const vectors = await db.openTable('vectors');
  const original = (
    await vectors.query().where("sessionId = 'synthetic'").limit(1).toArray()
  )[0] as Record<string, unknown> & { toJSON?: () => Record<string, unknown> };
  assert.ok(original);
  const seed: Record<string, unknown> = original.toJSON ? original.toJSON() : original;
  await vectors.add(
    Array.from({ length: 10001 }, (_, index) => {
      const angle = ((index % 360) * Math.PI) / 180;
      return {
        ...seed,
        chunkId: `synthetic-scale-${index}`,
        vector: [Math.cos(angle), Math.sin(angle)],
      };
    }),
  );
  vectors.close();
  db.close();
  const reopened = await openStore({ root, embedder });
  t.after(() => reopened.close());
  const result = await reopened.search(query('scale query', 'semantic'));
  assert.equal(result.coverage.method, 'ivf-flat-candidates');
  assert.equal(result.coverage.rerank, 'exact-cosine');
  assert.equal(result.coverage.annExhaustive, false);
  assert.equal(result.candidateTruncated, true);
  assert.equal(result.hits[0].similarity, 1);
  assert.equal(result.hits[0].ref, 'synthetic:0');
  const small = await reopened.search(
    query('small query', 'semantic', { sessionIds: ['small-scope'], role: 'assistant' }),
  );
  assert.equal(small.coverage.method, 'exact-flat-cosine');
  assert.equal(small.hits[0].sessionId, 'small-scope');
  const inspect = await lance.connect(join(root, 'db'));
  const indexed = await inspect.openTable('vectors');
  const index = (await indexed.listIndices()).find((item) => item.columns.includes('vector'));
  assert.ok(index);
  assert.equal(index.indexType, 'IvfFlat');
  indexed.close();
  inspect.close();
});

test('literal punctuation queries never depend on FTS tokenizer and excerpt intervals match', async (t) => {
  const { store } = await fixture(t);
  const text = 'prefix *** <=> \n\n 🐳 suffix';
  await store.sync(batch('synthetic', [{ seq: 0, text }]));
  for (const needle of ['***', '<=>', '\n\n', '🐳']) {
    const result = await store.search(query(needle));
    assert.equal(result.hits.length, 1);
    const hit = result.hits[0];
    assert.equal(hit.excerpt, text.slice(hit.start, hit.end));
    assert.equal(text.slice(hit.matchStart, hit.matchEnd), needle);
  }
  const read = await store.read({ ref: 'synthetic:0', length: 5, before: 0, after: 0 });
  assert.deepEqual(read.context, []);
});

test('reject malformed input without checkpointing or exposing a partially indexed source', async (t) => {
  const { root, store } = await fixture(t);
  const malformed = batch('synthetic', [{ seq: 0, text: 'omitted block' }]);
  malformed.blocks = [];
  await assert.rejects(store.sync(malformed), rejects('INVALID_REQUEST'));
  assert.equal((await store.status()).counts.sessions, 0);
  assert.deepEqual(await readdir(join(root, 'journals')), []);
  const duplicate = batch('synthetic', [
    { seq: 0, text: 'a' },
    { seq: 0, text: 'b' },
  ]);
  await assert.rejects(store.sync(duplicate), rejects('SOURCE_CHANGED'));
  await assert.rejects(store.search(query('')), rejects('INVALID_REQUEST'));
  await assert.rejects(store.search(query('  ', 'fuzzy')), rejects('INVALID_REQUEST'));
  await assert.rejects(
    store.search(query('x', 'exact', { sessionIds: undefined })),
    rejects('INVALID_REQUEST'),
  );
});
