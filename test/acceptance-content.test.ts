import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRuntime } from '../dist/host/plugin.js';
import { chunkText } from '../dist/core/chunking.js';
import type {
  HostContext,
  SessionEvent,
  SourceBlock,
  ToolDefinition,
} from '../dist/host/contracts.js';
import type { SyncSummary } from '../dist/host/types.js';
import type { ContextMessage, ReadResult } from '../dist/shared/model.js';
import type { SearchResult } from '../dist/storage/store.js';
import { nodeSubprocess } from './helpers/host.ts';

// Synthetic public-service responses only. The production Host, bridge, JSONL
// worker, LanceDB store and source verification run unchanged from build output.
// No real session, attachment bytes, embedding service or model is exercised.
const sessionId = 'synthetic-content-acceptance';
const imageAttachment = {
  attachmentId: 'synthetic-missing-image',
  mediaType: 'image/png',
  name: 'synthetic-image.png',
  bytes: 48,
  width: 1,
  height: 1,
};
const pdfAttachment = {
  attachmentId: 'synthetic-missing-pdf',
  name: 'synthetic-document.pdf',
  bytes: 128,
};
const image: SourceBlock = { type: 'image', attachment: imageAttachment };
const pdf: SourceBlock = { type: 'file', attachment: pdfAttachment };
const text = (value: string): SourceBlock => ({ type: 'text', text: value });
function message(
  seq: number,
  content: SourceBlock[],
  role: 'user' | 'assistant' = 'user',
): SessionEvent {
  const value = {
    id: `synthetic-original-${seq}`,
    role,
    source:
      role === 'user'
        ? { kind: 'user' }
        : { kind: 'model', provider: 'synthetic', model: 'synthetic' },
    content,
  };
  return {
    seq,
    time: 1_000 + seq,
    type: `${role}/message`,
    surfaceOp: 'append',
    data: role === 'user' ? value : { message: value, turn: 1, step: seq + 1, stream: [] },
  };
}
interface VerifiedRead extends ReadResult {
  verified: boolean;
  historicalText: boolean;
  nextCursor: string | null;
  context: (ContextMessage & { verified: boolean })[];
  source: {
    sessionId: string;
    seq: number;
    blockIndex: number;
    messageId: string | null;
    sourceKind: string;
    inherited: boolean;
  };
}
interface ToolResults {
  search: SearchResult & { synchronization?: SyncSummary };
  read: VerifiedRead;
}
type SourceFailureCode = 'EACCES' | 'ENOENT';
async function fixture(t: TestContext, events: SessionEvent[]) {
  const tools = new Map<string, ToolDefinition>();
  const closes: (() => Promise<void>)[] = [];
  const sourceReads: number[] = [];
  const failures: { snapshot: SourceFailureCode | null; event: SourceFailureCode | null } = {
    snapshot: null,
    event: null,
  };
  const sourceFailure = (code: SourceFailureCode) =>
    Object.assign(new Error('Synthetic source read failed.'), { code });
  const header = { id: sessionId, cwd: '/synthetic/not-opened', createdAt: 1 };
  const ctx: HostContext = {
    subprocess: nodeSubprocess(),
    sessions: { get: () => undefined },
    get: () => undefined,
    sessionQuery: {
      listSessions: async () => [{ header }],
      observeSession: async () => {
        throw new Error('Synthetic cold session must use the public query fallback.');
      },
      readSession: async (id) => {
        assert.equal(id, sessionId);
        if (failures.snapshot) throw sourceFailure(failures.snapshot);
        return { session: header, inheritedEventCount: 0, events: structuredClone(events) };
      },
      readEvent: async ({ sessionId: id, seq, before, after }) => {
        assert.equal(id, sessionId);
        assert.equal(before, 0);
        assert.equal(after, 0);
        sourceReads.push(seq);
        if (failures.event) throw sourceFailure(failures.event);
        const target = events.find((event) => event.seq === seq);
        assert.ok(target);
        return { session: header, inheritedEventCount: 0, target: structuredClone(target) };
      },
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on: () => {},
    effect: (factory) => closes.push(factory()),
  };
  applyRuntime(ctx, {
    nodePath: process.env.RECALL_TEST_NODE ?? process.execPath,
    dataPath: await mkdtemp(join(tmpdir(), 'dsh-recall-content-')),
    sessionIds: [sessionId],
    embeddingSessionIds: [],
    callerSessionIds: [sessionId],
    autoSync: false,
    dominantMin: 0.5,
    dominantGap: 0.15,
  });
  t.after(async () => {
    for (const close of closes) await close();
  });
  const call = async <Name extends keyof ToolResults>(
    name: Name,
    args: unknown,
  ): Promise<ToolResults[Name]> => {
    const tool = tools.get(`chat_recall_${name}`);
    assert.ok(tool);
    return (await tool.execute(args, {
      agent: { id: sessionId },
      signal: new AbortController().signal,
    })) as ToolResults[Name];
  };
  return { call, failures, sourceReads };
}

test('Host preserves ordered text and image/PDF references without attachment bytes', async (t) => {
  const firstText = '混合原话：图片前\r\n  保留空白🐳';
  const middleText = '混合原话：图片后、PDF前𠮷';
  const historicalData =
    '混合原话：PDF后；历史路径 /synthetic/do-not-open.txt；' +
    'URL https://example.invalid/do-not-request；历史命令 printf "HISTORICAL_ONLY"';
  const mixed = [
    { type: 'reasoning', text: 'not visible' },
    text(firstText),
    image,
    text(middleText),
    pdf,
    text(historicalData),
  ];
  // These IDs have no corresponding files or attachment service in this fixture.
  const { call } = await fixture(t, [
    message(0, [text('前一条原话')]),
    message(1, mixed),
    message(2, [image, pdf]),
    message(3, [text('后一条原话')]),
  ]);
  const page = await call('search', {
    query: '混合原话',
    mode: 'exact',
    scope: 'current',
    limit: 10,
  });
  assert.deepEqual(
    page.hits.map((hit) => [hit.ref, hit.blockIndex]),
    [1, 3, 5].map((blockIndex) => [`${sessionId}:1`, blockIndex]),
  );
  const expectedTexts = new Map([
    [1, firstText],
    [3, middleText],
    [5, historicalData],
  ]);
  for (const hit of page.hits) {
    const read = await call('read', {
      ref: hit.ref,
      blockIndex: hit.blockIndex,
      before: 0,
      after: 0,
    });
    assert.equal(read.text, expectedTexts.get(hit.blockIndex));
    assert.equal(read.verified, true);
    assert.equal(read.historicalText, true);
    assert.equal(read.source.messageId, 'synthetic-original-1');
    assert.equal(read.source.blockIndex, hit.blockIndex);
    assert.deepEqual(
      read.attachments.map((part) => [part.blockIndex, part.type, part.attachment]),
      [
        [2, 'image', imageAttachment],
        [4, 'file', pdfAttachment],
      ],
    );
  }
  // The target API reads one text block. The neighboring-message projection
  // exposes all visible blocks, so assert order there instead of concatenating.
  const adjacent = await call('read', { ref: `${sessionId}:0`, before: 0, after: 2 });
  assert.deepEqual(
    adjacent.context.map((neighbor) => [neighbor.ref, neighbor.verified]),
    [
      [`${sessionId}:1`, true],
      [`${sessionId}:2`, true],
    ],
  );
  assert.deepEqual(
    adjacent.context[0].content.map((part) => [
      part.blockIndex,
      part.type,
      part.text ?? null,
      part.attachment ?? null,
    ]),
    [
      [1, 'text', firstText, null],
      [2, 'image', null, imageAttachment],
      [3, 'text', middleText, null],
      [4, 'file', null, pdfAttachment],
      [5, 'text', historicalData, null],
    ],
  );
  const attachmentOnly = await call('read', { ref: `${sessionId}:2`, before: 1, after: 1 });
  assert.equal(attachmentOnly.verified, true);
  assert.equal(attachmentOnly.text, null);
  assert.equal(attachmentOnly.textHash, null);
  assert.equal(attachmentOnly.totalLength, 0);
  assert.equal(attachmentOnly.nextCursor, null);
  assert.deepEqual(
    attachmentOnly.attachments.map((part) => [part.blockIndex, part.type, part.attachment]),
    [
      [0, 'image', imageAttachment],
      [1, 'file', pdfAttachment],
    ],
  );
  assert.deepEqual(
    attachmentOnly.context.map((neighbor) => neighbor.ref),
    [`${sessionId}:1`, `${sessionId}:3`],
  );
  const filenameSearch = await call('search', {
    query: pdfAttachment.name,
    mode: 'exact',
    scope: 'current',
  });
  assert.equal(filenameSearch.hits.length, 0, 'references do not imply PDF body/OCR indexing');
  // This is deterministic quoted-data transport, not a new model-injection trial.
});

test('Host exact spans chunks without normalization and UTF-16 read cursors reconstruct verified source', async (t) => {
  const query = '界🐳𠮷\r\n精确e\u0301\u200b尾';
  const original = '甲'.repeat(598) + query + '乙'.repeat(850) + '\r\n  末页“保持原样”🙂';
  const start = original.indexOf(query);
  const chunks = chunkText(original);
  assert.ok(chunks.some((part) => part.end > start && part.end < start + query.length));
  assert.ok(
    chunks.every((part) => !part.text.includes(query)),
    'query spans, not fits in, a chunk',
  );
  const { call, sourceReads } = await fixture(t, [
    message(0, [{ type: 'reasoning', text: 'not indexed' }, text(original)], 'assistant'),
  ]);
  const page = await call('search', { query, mode: 'exact', scope: 'current', limit: 1 });
  assert.equal(page.hits.length, 1);
  const hit = page.hits[0];
  assert.equal(hit.ref, `${sessionId}:0`);
  assert.equal(hit.blockIndex, 1);
  assert.equal(hit.matchStart, start);
  assert.equal(hit.matchEnd, start + query.length);
  assert.equal(hit.excerpt, original.slice(hit.start, hit.end));
  assert.ok(hit.excerpt.includes(query));
  for (const normalized of [query.replace('\r\n', '\n'), query.normalize('NFC')]) {
    const absent = await call('search', { query: normalized, mode: 'exact', scope: 'current' });
    assert.equal(absent.hits.length, 0, 'exact must not normalize CRLF or combining marks');
  }
  // Both offsets deliberately point at a low surrogate; even length=1 must
  // return the complete astral character and advance by its UTF-16 length.
  for (const [offset, expected] of [
    [600, '🐳'],
    [602, '𠮷'],
  ] as const) {
    const single: VerifiedRead = await call('read', {
      ref: hit.ref,
      blockIndex: hit.blockIndex,
      offset,
      length: 1,
      before: 0,
      after: 0,
    });
    assert.equal(single.offset, offset - 1);
    assert.equal(single.text, expected);
    assert.equal(single.nextOffset, offset + 1);
    assert.equal(single.verified, true);
  }
  let read = await call('read', {
    ref: hit.ref,
    blockIndex: hit.blockIndex,
    length: 600,
    before: 0,
    after: 0,
  });
  assert.equal(read.nextOffset, 599, 'first page must not split the whale surrogate pair');
  let full = '';
  let pages = 0;
  while (true) {
    pages++;
    assert.equal(read.ref, hit.ref);
    assert.equal(read.blockIndex, hit.blockIndex);
    assert.equal(read.offset, full.length);
    assert.equal(read.totalLength, original.length);
    assert.equal(read.role, 'assistant');
    assert.equal(read.source.sourceKind, 'model');
    assert.equal(read.verified, true);
    assert.equal(read.historicalText, true);
    assert.equal(typeof read.text, 'string');
    assert.ok(read.text !== null && read.text.length > 0);
    assert.equal(Buffer.from(read.text, 'utf8').toString('utf8'), read.text);
    assert.ok(!read.text.includes('\uFFFD'));
    full += read.text;
    if (!read.nextCursor) {
      assert.equal(read.nextOffset, null);
      break;
    }
    assert.equal(read.nextOffset, full.length);
    assert.ok(pages < 10, 'read continuation must terminate without overlaps or gaps');
    read = await call('read', { cursor: read.nextCursor });
  }
  assert.equal(full, original);
  assert.ok(pages >= 3);
  assert.equal(
    sourceReads.length,
    pages + 2,
    'every page, including continuation, reads its source',
  );
});

test('Host refuses cached text and continuation when the original service is unreadable', async (t) => {
  const original = '缓存不是原源。'.repeat(20);
  const { call, failures, sourceReads } = await fixture(t, [
    message(0, [text(original)]),
    message(1, [text('unchanged checkpoint anchor')]),
  ]);
  const first = await call('read', { ref: `${sessionId}:0`, length: 8, before: 0, after: 0 });
  assert.equal(first.verified, true);
  assert.ok(first.nextCursor);
  // Mock public-service failures, not filesystem permission changes. Assert the
  // actual Host error code; do not invent a normalized SOURCE_UNAVAILABLE code.
  for (const code of ['EACCES', 'ENOENT'] as const) {
    failures.snapshot = code;
    failures.event = code;
    const before = sourceReads.length;
    await assert.rejects(call('read', { cursor: first.nextCursor }), { code });
    await assert.rejects(call('read', { ref: first.ref, length: 8, before: 0, after: 0 }), {
      code,
    });
    assert.equal(sourceReads.length, before + 2, 'cache cannot bypass source verification');
    const cachedCandidates = await call('search', {
      query: '缓存',
      mode: 'exact',
      scope: 'current',
    });
    assert.equal(cachedCandidates.hits.length, 1);
    assert.deepEqual(cachedCandidates.synchronization?.results, [{ sessionId, error: code }]);
    assert.equal(Object.hasOwn(cachedCandidates, 'verified'), false);
  }
  failures.snapshot = null;
  failures.event = null;
  const recovered = await call('read', { cursor: first.nextCursor });
  assert.equal(recovered.verified, true);
  assert.equal(recovered.offset, first.nextOffset);
  assert.equal(recovered.text, original.slice(first.nextOffset!, first.nextOffset! + 8));
});

test('Host rejects text, attachment-set and neighboring-source rewrites before verification', async (t) => {
  const original = '相同开头，但必须核对完整原文。' + '尾'.repeat(50);
  const events = [
    message(0, [text(original), image]),
    message(1, [text('相邻原话不能由缓存冒充')]),
    message(2, [text('unchanged checkpoint anchor')]),
  ];
  const { call } = await fixture(t, events);
  const first = await call('read', { ref: `${sessionId}:0`, length: 7, before: 0, after: 1 });
  assert.equal(first.verified, true);
  assert.ok(first.nextCursor);
  const changedImage: SourceBlock = {
    type: 'image',
    attachment: { ...imageAttachment, attachmentId: 'synthetic-rewritten-image' },
  };
  const changes = [
    {
      label: 'changed text outside the returned slice must fail the full-block hash',
      seq: 0,
      event: message(0, [text(original.slice(0, -1) + '改'), image]),
    },
    {
      label: 'a changed attachment reference must not be claimed as verified',
      seq: 0,
      event: message(0, [text(original), changedImage]),
    },
    {
      label: 'a newly added attachment must not be omitted from a verified result',
      seq: 0,
      event: message(0, [text(original), image, pdf]),
    },
    {
      label: 'a changed neighboring message must fail instead of returning cached context',
      seq: 1,
      event: message(1, [text('被改写的相邻原话')]),
    },
    {
      label: 'a newly added neighboring attachment must not be omitted from verified context',
      seq: 1,
      event: message(1, [text('相邻原话不能由缓存冒充'), pdf]),
    },
    {
      label: 'a source kind changed to tool cannot remain verified original user speech',
      seq: 1,
      event: {
        ...message(1, [text('相邻原话不能由缓存冒充')]),
        data: {
          id: 'synthetic-original-1',
          role: 'user',
          source: { kind: 'tool' },
          content: [text('相邻原话不能由缓存冒充')],
        },
      },
    },
  ];
  for (const change of changes) {
    const previous = events[change.seq];
    events[change.seq] = change.event;
    try {
      // The changed event is older than the stable checkpoint anchor, so this
      // assertion specifically exercises per-read verification of cached rows.
      await assert.rejects(
        call('read', { ref: first.ref, length: 7, before: 0, after: 1 }),
        { code: 'SOURCE_CHANGED' },
        change.label,
      );
      if (change.seq === 0)
        await assert.rejects(call('read', { cursor: first.nextCursor }), {
          code: 'SOURCE_CHANGED',
        });
    } finally {
      events[change.seq] = previous;
    }
  }
  const restored = await call('read', { ref: first.ref, length: 7, before: 0, after: 1 });
  assert.equal(restored.verified, true);
  assert.equal(restored.text, original.slice(0, 7));
});
