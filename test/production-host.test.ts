import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, applyRuntime, Config } from '../dist/host/plugin.js';
import { snapshotConfig } from '../dist/host/config.js';
import type { TimingReport } from '../dist/shared/timing.js';
import type { HostContext, SessionEvent, ToolDefinition } from '../dist/host/contracts.js';
import type { PendingSession, SyncSummary } from '../dist/host/types.js';
import type { ReadResult, SessionRow } from '../dist/shared/model.js';
import type { SearchResult, StoreStatus } from '../dist/storage/store.js';
import { nodeSubprocess } from './helpers/host.ts';

const nodePath = process.env.RECALL_TEST_NODE ?? process.execPath;

const message = (seq: number, text: string, role = 'user'): SessionEvent => ({
  seq,
  time: seq + 1,
  type: `${role}/message`,
  surfaceOp: 'append',
  data:
    role === 'user'
      ? { id: `message-${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] }
      : {
          message: {
            id: `message-${seq}`,
            role,
            source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            content: [{ type: 'text', text }],
          },
        },
});

type Dispose = () => Promise<void>;
interface ToolResults {
  search: SearchResult & { synchronization?: SyncSummary };
  read: ReadResult & { verified: boolean; nextCursor: string | null };
  status: StoreStatus;
  sessions: {
    sessions: (SessionRow | PendingSession)[];
    total: number;
    nextOffset: number | null;
    unindexedCount: number;
  };
}

function caller(tools: Map<string, ToolDefinition>) {
  return async <Name extends keyof ToolResults>(
    name: Name,
    args: unknown = {},
  ): Promise<ToolResults[Name]> => {
    const tool = tools.get(`chat_recall_${name}`);
    assert.ok(tool);
    // ToolDefinition intentionally returns unknown; this fixture knows each tool's result contract.
    return (await tool.execute(args, {
      agent: { id: 'caller' },
      signal: new AbortController().signal,
    })) as ToolResults[Name];
  };
}

test('Host syncs cold-range tails, freezes search pages and closes an ordinary real-process bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-host-'));
  const original = 'first anchor';
  const events = [message(0, original), message(1, 'another anchor'), message(2, 'third anchor')];
  const header = { id: 'fixture', cwd: '/test', createdAt: 1 };
  const tools = new Map<string, ToolDefinition>(),
    disposers: Dispose[] = [],
    listeners = new Map<string, Parameters<HostContext['on']>[1]>(),
    service = nodeSubprocess();
  const ctx = {
    subprocess: service,
    sessions: { get: () => undefined },
    get: (key: string) =>
      key === 'sessionPersistence'
        ? {
            open: async () => ({
              header,
              inheritedEventCount: 0,
              read: async (a: number, n: number) => ({ events: events.slice(a, a + n) }),
              close: async () => {},
            }),
          }
        : undefined,
    sessionQuery: {
      readEvent: async ({ seq }: { seq: number }) => ({
        session: header,
        inheritedEventCount: 0,
        target: events[seq],
      }),
    },
    tools: { register: (t: ToolDefinition) => tools.set(t.name, t) },
    on: (name: string, fn: Parameters<HostContext['on']>[1]) => listeners.set(name, fn),
    effect: (fn: () => Dispose) => disposers.push(fn()),
  };
  const config = Config({
    nodePath,
    dataPath: root,
    sessionIds: ['fixture'],
    callerSessionIds: ['caller'],
    autoSync: false,
  });
  apply(ctx as unknown as HostContext, config);
  const call = caller(tools);
  try {
    const statusTool = tools.get('chat_recall_status');
    assert.ok(statusTool);
    await assert.rejects(
      statusTool.execute({}, { agent: { id: 'other' }, signal: new AbortController().signal }),
      { code: 'OUT_OF_SCOPE' },
    );
    const first = await call('search', {
      query: 'anchor',
      mode: 'exact',
      scope: 'fixture',
      limit: 1,
    });
    assert.equal(first.hits.length, 1);
    assert.ok(first.nextCursor);
    assert.ok(first.synchronization);
    assert.ok('eventsRead' in first.synchronization.results[0]);
    assert.equal(first.synchronization.results[0].eventsRead, 3);
    events.push(message(3, 'fourth anchor'));
    const second = await call('search', {
      query: 'anchor',
      mode: 'exact',
      scope: 'fixture',
      cursor: first.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      second.hits.map((h) => h.eventSeq),
      [1, 2],
    );
    assert.equal(second.nextCursor, null);
    const refreshed = await call('search', {
      query: 'anchor',
      mode: 'exact',
      scope: 'fixture',
      limit: 20,
    });
    assert.equal(refreshed.hits.length, 4);
    assert.ok(refreshed.synchronization);
    assert.ok('eventsRead' in refreshed.synchronization.results[0]);
    assert.equal(refreshed.synchronization.results[0].eventsRead, 1);
    const absent = await call('search', {
      query: 'absent-from-this-corpus',
      mode: 'exact',
      scope: 'fixture',
    });
    assert.deepEqual(absent.hits, []);
    assert.equal(absent.nextCursor, null);
    assert.equal(absent.coverage.exhaustive, true);
    const result = await call('read', { ref: 'fixture:0', blockIndex: 0, before: 0, after: 0 });
    assert.equal(result.text, original);
    assert.equal(result.verified, true);
    await assert.rejects(call('search', { query: 'meaning', mode: 'semantic', scope: 'fixture' }), {
      code: 'EMBEDDING_SCOPE_NOT_ENABLED',
    });
    const state = await call('status');
    assert.equal(state.counts.messages, 4);
    assert.equal(state.embedding.configured, false);
  } finally {
    for (const dispose of disposers) await dispose();
  }
  assert.ok(service.children.every((p) => p.exitCode !== null || p.signalCode));
});

test('all-scope cursor freezes membership when new sessions appear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-host-membership-'));
  const ids = ['s1'],
    events = new Map([['s1', [message(0, 'needle first'), message(1, 'needle second')]]]);
  const tools = new Map<string, ToolDefinition>(),
    disposers: Dispose[] = [],
    service = nodeSubprocess();
  const ctx = {
    subprocess: service,
    sessions: { get: () => undefined },
    get: () => ({
      open: async (id: string) => ({
        header: { id, createdAt: 1 },
        inheritedEventCount: 0,
        read: async (a: number, n: number) => {
          const source = events.get(id);
          assert.ok(source);
          return { events: source.slice(a, a + n) };
        },
        close: async () => {},
      }),
    }),
    sessionQuery: { listSessions: async () => ids.map((id) => ({ header: { id } })) },
    tools: { register: (t: ToolDefinition) => tools.set(t.name, t) },
    on: () => {},
    effect: (fn: () => Dispose) => disposers.push(fn()),
  };
  apply(
    ctx as unknown as HostContext,
    Config({ nodePath, dataPath: root, sessionIds: ['all'], autoSync: false }),
  );
  const call = caller(tools);
  try {
    const first = await call('search', { query: 'needle', mode: 'exact', scope: 'all', limit: 1 });
    ids.push('s2');
    events.set('s2', [message(0, 'new needle')]);
    const second = await call('search', {
      query: 'needle',
      mode: 'exact',
      scope: 'all',
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.hits[0].ref, 's1:1');
    assert.equal(second.nextCursor, null);
    const page = await call('sessions', { scope: 'all', limit: 1 });
    assert.equal(page.total, 2);
    ids.push('s3');
    events.set('s3', [message(0, 'another new')]);
    const next = await call('sessions', { scope: 'all', limit: 1, offset: 1 });
    assert.equal(next.total, 2);
    assert.notEqual(next.sessions[0].sessionId, page.sessions[0].sessionId);
  } finally {
    for (const dispose of disposers) await dispose();
  }
});

test('manual broad synchronization rotates beyond unchanged first twenty sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-host-rotation-'));
  const ids = Array.from({ length: 21 }, (_, n) => `s${String(n).padStart(2, '0')}`),
    events = new Map(ids.map((id) => [id, [message(0, `original ${id}`)]]));
  const tools = new Map<string, ToolDefinition>(),
    disposers: Dispose[] = [],
    service = nodeSubprocess();
  const ctx = {
    subprocess: service,
    sessions: { get: () => undefined },
    get: () => ({
      open: async (id: string) => ({
        header: { id, createdAt: 1 },
        inheritedEventCount: 0,
        read: async (a: number, n: number) => {
          const source = events.get(id);
          assert.ok(source);
          return { events: source.slice(a, a + n) };
        },
        close: async () => {},
      }),
    }),
    sessionQuery: {},
    tools: { register: (t: ToolDefinition) => tools.set(t.name, t) },
    on: () => {},
    effect: (fn: () => Dispose) => disposers.push(fn()),
  };
  apply(
    ctx as unknown as HostContext,
    Config({ nodePath, dataPath: root, sessionIds: ids, autoSync: false }),
  );
  const call = caller(tools);
  try {
    const initial = await call('sessions', { scope: 'all', limit: 20 });
    assert.equal(initial.total, 21);
    assert.equal(initial.nextOffset, 20);
    assert.equal(initial.unindexedCount, 1);
    const last = await call('sessions', { scope: 'all', limit: 20, offset: 20 });
    assert.equal(last.sessions[0].sessionId, 's20');
    assert.ok('indexed' in last.sessions[0]);
    assert.equal(last.sessions[0].indexed, false);
    await call('status', { action: 'sync', scope: 'all' });
    await call('status', { action: 'sync', scope: 'all' });
    const lastEvents = events.get('s20');
    assert.ok(lastEvents);
    lastEvents.push(message(1, 'new last session message'));
    await call('status', { action: 'sync', scope: 'all' });
    const final = await call('status', { action: 'sync', scope: 'all' });
    const checkpoint = final.checkpoints.find((row) => row.sessionId === 's20');
    assert.ok(checkpoint);
    assert.equal(checkpoint.cursor, 1);
  } finally {
    for (const dispose of disposers) await dispose();
  }
});

test('production semantic adaptive single hit keeps top3 and continuation embeds no query', async () => {
  interface EmbeddingRequest {
    input: string[];
  }
  const requests: EmbeddingRequest[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text) as EmbeddingRequest;
    requests.push(body);
    const vector = (s: string) =>
      s.includes('rocket') ? [1, 0] : s.includes('ocean') ? [0, 1] : [-1, 0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: vector(s) })) }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-host-semantic-'));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const envFile = join(root, 'mock.env');
  await writeFile(
    envFile,
    `OPENAI_API_KEY=not-real\nOPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1\nOPENAI_EMBEDDING_MODEL=mock\n`,
  );
  const events = [message(0, 'rocket'), message(1, 'ocean'), message(2, 'forest')],
    header = { id: 'fixture', createdAt: 1 };
  const tools = new Map<string, ToolDefinition>(),
    disposers: Dispose[] = [],
    service = nodeSubprocess();
  const ctx = {
    subprocess: service,
    sessions: { get: () => undefined },
    get: () => ({
      open: async () => ({
        header,
        inheritedEventCount: 0,
        read: async (a: number, n: number) => ({ events: events.slice(a, a + n) }),
        close: async () => {},
      }),
    }),
    sessionQuery: {
      readEvent: async ({ seq }: { seq: number }) => ({
        session: header,
        inheritedEventCount: 0,
        target: events[seq],
      }),
    },
    tools: { register: (t: ToolDefinition) => tools.set(t.name, t) },
    on: () => {},
    effect: (fn: () => Dispose) => disposers.push(fn()),
  };
  const reports: { tool: string; ok: boolean; timing: TimingReport }[] = [];
  applyRuntime(
    ctx as unknown as HostContext,
    snapshotConfig(
      Config({
        nodePath,
        dataPath: root,
        envFile,
        sessionIds: ['fixture'],
        embeddingSessionIds: ['fixture'],
        autoSync: false,
      }),
    ),
    { onTiming: (report) => reports.push(report) },
  );
  const call = caller(tools);
  try {
    const first = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
    });
    assert.equal(first.hits.length, 1);
    assert.equal(first.presentation.comparison.top3.length, 3);
    assert.ok(first.nextCursor);
    const n = requests.length;
    const second = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
      cursor: first.nextCursor,
      limit: 5,
    });
    assert.equal(second.hits.length, 2);
    assert.equal(requests.length, n);
    assert.equal(requests.filter((r) => r.input.includes('rocket')).length, 1);
    assert.equal(reports.length, 2);
    const firstNames = new Set<string>(reports[0].timing.spans.map((s) => s.name));
    for (const name of [
      'host.synchronize',
      'host.embedding-catchup',
      'host.search',
      'bridge.roundtrip',
      'worker.total',
      'worker.queue',
      'embedding.http',
      'store.pending',
      'store.progress-index',
      'store.vector-fetch',
      'store.snapshot',
    ])
      assert.ok(firstNames.has(name), name);
    assert.equal(reports[0].timing.spans.find((s) => s.name === 'embedding.http')?.count, 2);
    assert.ok(!reports[1].timing.spans.some((s) => s.name === 'embedding.http'));
    assert.ok(!('timing' in first));
    assert.ok(!JSON.stringify(reports).includes('rocket'));
    await call('read', { ref: first.hits[0].ref, before: 0, after: 0 });
    assert.ok(reports[2].timing.spans.some((s) => s.name === 'host.source-verify'));

    // Tail additions must be embedded once, with role/time filtering preserved.
    events.push(message(3, 'rocket user tail'));
    events.push(message(4, 'rocket assistant tail', 'assistant'));
    const beforeIncrement = requests.length;
    const assistant = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
      role: 'assistant',
      from: 5,
      to: 5,
      limit: 3,
    });
    assert.deepEqual(
      assistant.hits.map((hit) => [hit.eventSeq, hit.role]),
      [[4, 'assistant']],
    );
    assert.equal(requests.length, beforeIncrement + 2, 'one new document batch and one query');
    assert.equal(requests.filter((r) => r.input.includes('rocket user tail')).length, 1);
    assert.equal(requests.filter((r) => r.input.includes('rocket assistant tail')).length, 1);
    const user = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
      role: 'user',
      from: 4,
      to: 4,
      limit: 3,
    });
    assert.deepEqual(
      user.hits.map((hit) => [hit.eventSeq, hit.role]),
      [[3, 'user']],
    );
    assert.equal(requests.length, beforeIncrement + 3, 'only the second query is embedded');
    const reused = await call('status', { action: 'embed', scope: 'fixture' });
    assert.equal(reused.counts.vectors, 5);
    assert.equal(reused.embedding.pendingBlocks, 0);
    assert.equal(requests.length, beforeIncrement + 3);
    const verifiedTail = await call('read', { ref: 'fixture:4', before: 0, after: 0 });
    assert.equal(verifiedTail.verified, true);
    assert.equal(verifiedTail.text, 'rocket assistant tail');
  } finally {
    for (const dispose of disposers) await dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
