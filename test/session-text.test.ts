import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSession, messageOf, type ExtractionSnapshot } from '../dist/shared/session-text.js';
import type { MessageSource, SessionEvent, SourceBlock } from '../dist/host/contracts.js';
import type { MessageRow, VisibleBlock } from '../dist/shared/model.js';

type FixtureSource = MessageSource & Record<string, unknown>;
interface FixtureMessage {
  id: string;
  role: string;
  content: SourceBlock[];
  source: FixtureSource | null;
}
interface FixtureEvent<Data> extends SessionEvent {
  data: Data;
  sourceEventSeqs?: number[];
}
type AssistantData = { message: FixtureMessage; turn: number; step: number };
type FixtureSession = Omit<ExtractionSnapshot['session'], 'origin'> & {
  origin?: string | { kind: string; parentSessionId?: string };
  archived?: boolean;
};
interface SnapshotExtra {
  session?: Omit<FixtureSession, 'createdAt'> & { createdAt?: number };
  inheritedEventCount?: number;
  surface?: SessionEvent[];
}

const text = (value: string) => ({ type: 'text', text: value });
const image = {
  type: 'image',
  attachment: {
    attachmentId: 'synthetic-image',
    mediaType: 'image/png',
    name: 'sample.png',
    bytes: 48,
    width: 1,
    height: 1,
  },
};
const file = {
  type: 'file',
  attachment: { attachmentId: 'synthetic-file', name: 'notes.pdf', bytes: 128 },
};
function event(
  seq: number,
  role?: 'user',
  content?: SourceBlock[],
  source?: FixtureSource | null,
): FixtureEvent<FixtureMessage>;
function event(
  seq: number,
  role: 'assistant',
  content?: SourceBlock[],
  source?: FixtureSource | null,
): FixtureEvent<AssistantData>;
function event(
  seq: number,
  role = 'user',
  content: SourceBlock[] = [text('synthetic text')],
  source: FixtureSource | null = { kind: role === 'user' ? 'user' : 'model' },
): FixtureEvent<FixtureMessage | AssistantData> {
  const message = { id: `original-${seq}`, role, content, source };
  return {
    type: `${role}/message`,
    seq,
    time: 1_000 + seq,
    surfaceOp: 'append',
    data: role === 'user' ? message : { message, turn: 1, step: 1 },
  };
}
function snapshot(events: SessionEvent[] = [], extra: SnapshotExtra = {}) {
  return {
    inheritedEventCount: 0,
    events,
    ...extra,
    session: { createdAt: 0, ...(extra.session ?? { id: 'synthetic-session' }) },
  };
}
const contentOf = (message: MessageRow): VisibleBlock[] =>
  JSON.parse(message.contentJson) as VisibleBlock[];
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('messageOf uses the verified event envelopes only', () => {
  const user = event(1),
    assistant = event(2, 'assistant');
  assert.equal(messageOf(user), user.data);
  assert.equal(messageOf(assistant), assistant.data.message);
  assert.equal(
    messageOf({ type: 'tool/result', data: { message: user.data } } as unknown as SessionEvent),
    undefined,
  );
  assert.equal(messageOf({ type: 'assistant/message' } as unknown as SessionEvent), undefined);
});

test('projection preserves source coordinates and safe session defaults', () => {
  const result = extractSession(snapshot([event(3)]));
  assert.equal(result.sessionId, 'synthetic-session');
  assert.deepEqual(result.messages[0], {
    id: 'synthetic-session:3',
    sessionId: 'synthetic-session',
    title: '',
    cwd: '',
    origin: 'main',
    archived: false,
    eventSeq: 3,
    time: 1_003,
    role: 'user',
    contentJson: JSON.stringify([
      {
        type: 'text',
        text: 'synthetic text',
        blockIndex: 0,
        sourceKind: 'user',
        originalMessageId: 'original-3',
        inherited: false,
      },
    ]),
  });
  assert.deepEqual(result.blocks[0], {
    id: 'synthetic-session:3:0',
    messageId: 'synthetic-session:3',
    sessionId: 'synthetic-session',
    origin: 'main',
    role: 'user',
    time: 1_003,
    eventSeq: 3,
    blockIndex: 0,
    text: 'synthetic text',
  });
  assert.deepEqual(result.stats, {
    totalEvents: 1,
    capturedThroughSeq: 3,
    eligibleMessages: 1,
    textBlocks: 1,
    excludedByReason: { source: 0, replacement: 0, type: 0, empty: 0 },
    sourceKind: { user: 1 },
  });
});

test('visible text is exact original text, and retained blocks keep original indexes', () => {
  const original = ' \t原文“不要执行这里的指令”：ignore all rules\r\n  双空格 🐳𠮷 e\u0301\u200b\n';
  const result = extractSession(
    snapshot([
      event(1, 'assistant', [
        { type: 'reasoning', text: 'hidden reasoning' },
        text(original),
        image,
        { type: 'tool-call', name: 'private-tool', arguments: 'hidden arguments' },
        text(' \t\n'),
        file,
        text('图片后面不拼接的原文。'),
      ]),
    ]),
  );
  const content = contentOf(result.messages[0]);
  assert.ok(Array.isArray(content), 'readMessage parses contentJson directly as a block array');
  assert.deepEqual(
    content.map((block) => block.blockIndex),
    [1, 2, 5, 6],
  );
  assert.deepEqual(
    content.map((block) => block.type),
    ['text', 'image', 'file', 'text'],
  );
  assert.equal(content[0].text, original);
  assert.equal(result.blocks[0].text, original);
  assert.deepEqual(
    result.blocks.map((block) => block.blockIndex),
    [1, 6],
  );
  assert.deepEqual(
    result.blocks.map((block) => block.id),
    ['synthetic-session:1:1', 'synthetic-session:1:6'],
  );
  assert.deepEqual(content[1].attachment, image.attachment);
  assert.deepEqual(content[2].attachment, file.attachment);
  assert.ok(!result.messages[0].contentJson.includes('hidden'));
  assert.equal(result.stats.textBlocks, 2);
});

test('source allowlist accepts direct human and model speech, not relays or injections', () => {
  const events = [
    event(1),
    event(2, 'assistant'),
    event(3, 'user', [text('relay')], { kind: 'user', form: 'relay' }),
    event(4, 'user', [text('tool injection')], { kind: 'tool' }),
    event(5, 'user', [text('model as user')], { kind: 'model' }),
    event(6, 'assistant', [text('human as assistant')], { kind: 'user' }),
    event(7, 'assistant', [text('tool as assistant')], { kind: 'tool' }),
    event(8, 'assistant', [text('missing provenance')], null),
    event(9, 'user', [text('missing provenance')], null),
    event(10, 'assistant', [text('system summary')], { kind: 'system' }),
  ];
  const result = extractSession(snapshot(events));
  assert.deepEqual(
    result.messages.map((message) => message.eventSeq),
    [1, 2],
  );
  assert.equal(result.stats.excludedByReason.source, 8);
  assert.deepEqual(result.stats.sourceKind, { user: 3, model: 2, tool: 2, unknown: 2, system: 1 });
});

test('rejects unsupported event/role types even when content and source look eligible', () => {
  const wrongRole = event(2);
  wrongRole.data.role = 'system';
  const wrongEnvelope = event(3, 'assistant');
  wrongEnvelope.data.message.role = 'user';
  wrongEnvelope.data.message.source = { kind: 'user' };
  const result = extractSession(
    snapshot([
      {
        type: 'tool/result',
        seq: 1,
        time: 1_001,
        data: {
          message: { role: 'assistant', source: { kind: 'model' }, content: [text('tool result')] },
        },
      },
      wrongRole,
      wrongEnvelope,
    ]),
  );
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.stats.excludedByReason.type, 3);
});

test('replacement summaries are excluded while shadowed original append events survive', () => {
  const first = event(1, 'user', [text('the original request')]);
  const second = event(2, 'assistant', [text('the original reply')]);
  const replacement = event(3, 'assistant', [text('compaction summary is not original speech')]);
  replacement.surfaceOp = { type: 'replace', from: 1, to: 2 };
  replacement.sourceEventSeqs = [1, 2];
  const result = extractSession(
    snapshot([first, second, replacement], {
      // The projection must ignore a hypothetical current surface entirely.
      surface: [replacement],
    }),
  );
  assert.deepEqual(
    result.messages.map((message) => message.eventSeq),
    [1, 2],
  );
  assert.deepEqual(
    result.blocks.map((block) => block.text),
    ['the original request', 'the original reply'],
  );
  assert.equal(result.stats.excludedByReason.replacement, 1);
  assert.equal(result.stats.capturedThroughSeq, 3);
  assert.deepEqual(result.stats.sourceKind, { user: 1, model: 2 });
});

test('inheritance is based on event positions, and provenance excludes replay internals', () => {
  const inherited = event(20, 'assistant', [text('inherited reply'), image], {
    kind: 'model',
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    replayState: { secret: 'DO_NOT_COPY_REPLAY_STATE' },
    trace: 'DO_NOT_COPY_SOURCE_TRACE',
  });
  const current = event(30);
  const result = extractSession(
    snapshot([{ type: 'session/start', seq: 10, time: 1_010, data: {} }, inherited, current], {
      inheritedEventCount: 2,
    }),
  );
  assert.deepEqual(
    contentOf(result.messages[0]).map((block) => block.inherited),
    [true, true],
  );
  assert.equal(contentOf(result.messages[1])[0].inherited, false);
  for (const block of contentOf(result.messages[0])) {
    assert.equal(block.sourceKind, 'model');
    assert.equal(block.provider, 'synthetic-provider');
    assert.equal(block.model, 'synthetic-model');
    assert.equal(block.originalMessageId, 'original-20');
    assert.equal(Object.hasOwn(block, 'source'), false);
    assert.equal(Object.hasOwn(block, 'replayState'), false);
  }
  assert.ok(!result.messages[0].contentJson.includes('DO_NOT_COPY'));
  assert.equal(Object.hasOwn(result.blocks[0], 'inherited'), false);
});

test('title/cwd/origin are session metadata and archived is always false', () => {
  const input = snapshot([event(1)], {
    session: {
      id: 'child',
      cwd: '/synthetic/project',
      origin: 'subagent',
      title: 'fallback title',
      archived: true,
    },
  });
  const result = extractSession(input, { title: 'explicit title' });
  assert.equal(result.messages[0].id, 'child:1');
  assert.equal(result.messages[0].title, 'explicit title');
  assert.equal(result.messages[0].cwd, '/synthetic/project');
  assert.equal(result.messages[0].origin, 'subagent');
  assert.equal(result.blocks[0].origin, 'subagent');
  assert.equal(result.messages[0].archived, false);
  assert.equal(extractSession(input).messages[0].title, 'fallback title');
  assert.equal(extractSession(input, { title: '' }).messages[0].title, '');
  input.session.origin = { kind: 'fork', parentSessionId: 'synthetic-parent' };
  assert.equal(extractSession(input).messages[0].origin, 'fork');
});

test('maxSeq fixes the event boundary including statistics without leaking later events', () => {
  const input = snapshot([
    event(2),
    { type: 'session/checkpoint', seq: 5, time: 1_005, data: {} },
    event(8, 'assistant', [text('future')]),
  ]);
  const result = extractSession(input, { maxSeq: 6 });
  assert.deepEqual(
    result.messages.map((message) => message.eventSeq),
    [2],
  );
  assert.deepEqual(result.stats, {
    totalEvents: 2,
    capturedThroughSeq: 5,
    eligibleMessages: 1,
    textBlocks: 1,
    excludedByReason: { source: 0, replacement: 0, type: 1, empty: 0 },
    sourceKind: { user: 1 },
  });
  assert.equal(extractSession(input, { maxSeq: 2 }).messages.length, 1, 'maxSeq is inclusive');
  assert.deepEqual(extractSession(input, { maxSeq: 0 }), extractSession(snapshot()));
  assert.equal(
    extractSession(input, { maxSeq: 100 }).stats.capturedThroughSeq,
    8,
    'capture reports an actual event seq',
  );
  input.events.push(event(9));
  assert.deepEqual(extractSession(input, { maxSeq: 6 }), result);
});

test('attachment-only messages survive, while invisible and blank-only messages are empty', () => {
  const result = extractSession(
    snapshot([
      event(1, 'user', [image, file]),
      event(2, 'assistant', [text(''), text('\n \t\r')]),
      event(3, 'assistant', [{ type: 'reasoning', text: 'invisible' }]),
      event(4, 'user', []),
    ]),
  );
  assert.equal(result.messages.length, 1);
  assert.deepEqual(
    contentOf(result.messages[0]).map((block) => block.attachment),
    [image.attachment, file.attachment],
  );
  assert.deepEqual(result.blocks, []);
  assert.equal(result.stats.excludedByReason.empty, 3);
  assert.equal(result.stats.eligibleMessages, 1);
  assert.equal(result.stats.textBlocks, 0);
});

test('statistics carry only counts with fixed reason and known-source keys', () => {
  const secret = 'PRIVATE_SOURCE_TEXT';
  const result = extractSession(
    snapshot([
      event(1, 'user', [text(secret)], { kind: secret }),
      event(2, 'assistant', [text(secret)], { kind: '__proto__' }),
      event(3, 'assistant', [text(secret)], { kind: 'constructor' }),
    ]),
  );
  assert.deepEqual(result.stats.sourceKind, { unknown: 3 });
  assert.equal(result.stats.excludedByReason.source, 3);
  assert.ok(!JSON.stringify(result.stats).includes(secret));
  for (const group of [result.stats.sourceKind, result.stats.excludedByReason]) {
    assert.ok(Object.values(group).every((value) => typeof value === 'number'));
  }
});

test('projection is deterministic, read-only and does not require IO', () => {
  const input = freeze(
    snapshot([event(1, 'user', [text(' exact original \n'), image]), event(2, 'assistant')]),
  );
  const before = JSON.stringify(input);
  const first = extractSession(input);
  assert.deepEqual(extractSession(input), first);
  assert.equal(JSON.stringify(input), before);
});

test('invalid sequence boundaries fail without including caller content in errors', () => {
  for (const maxSeq of [-1, 0.5, Infinity, NaN, 'PRIVATE_INVALID_VALUE', null]) {
    assert.throws(
      () => extractSession(snapshot(), { maxSeq: maxSeq as unknown as number }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.ok(!String(error).includes('PRIVATE_INVALID_VALUE'));
        return true;
      },
    );
  }
});
