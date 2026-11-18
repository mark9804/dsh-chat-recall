import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply, applyRuntime, Config, type RuntimeDiagnostics } from '../dist/host/plugin.js';
import { snapshotConfig } from '../dist/host/config.js';
import type {
  HostContext,
  SessionEvent,
  SessionHeader,
  ToolDefinition,
} from '../dist/host/contracts.js';
import type { PendingSession, PluginConfig, SyncSummary } from '../dist/host/types.js';
import type { ReadResult, SessionRow } from '../dist/shared/model.js';
import type { SearchResult, StoreStatus } from '../dist/storage/store.js';
import { nodeSubprocess } from './helpers/host.ts';

const nodePath = process.env.RECALL_TEST_NODE ?? process.execPath;

function message(
  seq: number,
  text: string | string[],
  role: 'user' | 'assistant' = 'user',
): SessionEvent {
  const data = {
    id: `message-${seq}`,
    role,
    source:
      role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: (Array.isArray(text) ? text : [text]).map((text) => ({ type: 'text', text })),
  };
  return {
    seq,
    time: seq + 1,
    type: `${role}/message`,
    surfaceOp: 'append',
    data: role === 'user' ? data : { message: data },
  };
}

type Dispose = () => Promise<void>;
interface ToolResults {
  search: SearchResult & { synchronization?: SyncSummary };
  read: ReadResult & { verified: boolean; nextCursor: string | null };
  status: StoreStatus & {
    autoEmbed: boolean;
    dirtySessions: number;
    syncErrors: { sessionId: string; code: string }[];
    autoEmbedErrors: { sessionId: string; code: string }[];
  };
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
    signal = new AbortController().signal,
  ): Promise<ToolResults[Name]> => {
    const tool = tools.get(`chat_recall_${name}`);
    assert.ok(tool);
    // ToolDefinition intentionally returns unknown; this fixture knows each tool's result contract.
    return (await tool.execute(args, {
      agent: { id: 'caller' },
      signal,
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

const EMBEDDING_KEY = 'synthetic-embedding-key';
const EMBEDDING_ERROR = 'synthetic provider diagnostics';
const cursor = (state: StoreStatus, id: string) =>
  state.checkpoints.find((row) => row.sessionId === id)?.cursor;

type FixtureSession = { header: SessionHeader; events: SessionEvent[] };
const session = (id: string, events: SessionEvent[], origin?: string): FixtureSession => ({
  header: { id, createdAt: 1, origin },
  events,
});

// The semantic and background paths share the same real worker and loopback transport fixture.
async function embeddingFixture(t: TestContext, sessions: FixtureSession[]) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'dsh-recall-embedding-'));
  const subprocess = nodeSubprocess();
  const requests: string[][] = [];
  const rejected = new Set<string>();
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      req.setEncoding('utf8');
      for await (const part of req) body += part;
      const { input } = JSON.parse(body) as { input: string[] };
      requests.push(input);
      const fails = input.some((text) => rejected.has(text));
      const data = input.map((text, index) => ({
        index,
        embedding: text.includes('rocket') ? [1, 0] : text.includes('ocean') ? [0, 1] : [-1, 0],
      }));
      res.writeHead(fails ? 429 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          fails ? { error: `${EMBEDDING_ERROR}: ${EMBEDDING_KEY} ${input.join(' ')}` } : { data },
        ),
      );
    } catch {
      res.destroy();
    }
  });
  const cleanupMs = 5_000;
  let dispose: Dispose | undefined;
  let publish: Parameters<HostContext['on']>[1] | undefined;
  async function close() {
    if (!dispose) return;
    const timeout = new AbortController();
    try {
      await Promise.race([
        dispose(),
        delay(cleanupMs, undefined, { signal: timeout.signal }).then(() =>
          assert.fail('Worker close deadline exceeded'),
        ),
      ]);
      dispose = undefined;
      publish = undefined;
    } finally {
      timeout.abort();
    }
  }
  t.after(async () => {
    try {
      await close();
    } finally {
      try {
        await Promise.all(
          subprocess.children.map(async (child) => {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
              return;
            const exited = once(child, 'close', { signal: AbortSignal.timeout(cleanupMs) });
            child.kill('SIGKILL');
            await exited;
          }),
        );
        // Remove only the fresh, still-owned directory, not a substituted link or path.
        assert.equal(dirname(root), temp);
        assert.ok((await lstat(root)).isDirectory());
        assert.equal(await realpath(root), root);
        await rm(root, { recursive: true });
      } finally {
        if (server.listening) {
          const closed = once(server, 'close', { signal: AbortSignal.timeout(cleanupMs) });
          server.close();
          server.closeAllConnections();
          await closed;
        }
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening', { signal: AbortSignal.timeout(cleanupMs) });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const envFile = join(root, 'mock.env');
  await writeFile(
    envFile,
    `OPENAI_API_KEY=${EMBEDDING_KEY}\nOPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1\nOPENAI_EMBEDDING_MODEL=mock\n`,
  );

  const sources = new Map(sessions.map((source) => [source.header.id, source]));
  function source(id: string) {
    const value = sources.get(id);
    assert.ok(value, `Unknown fixture session ${id}`);
    return value;
  }
  function start(
    config: Pick<PluginConfig, 'embeddingSessionIds'> &
      Partial<Pick<PluginConfig, 'autoSync' | 'autoEmbed'>>,
    diagnostics?: RuntimeDiagnostics,
  ) {
    assert.equal(dispose, undefined, 'Close the prior worker before reopening its index');
    const tools = new Map<string, ToolDefinition>();
    const ctx: HostContext = {
      subprocess,
      sessions: { get: () => undefined },
      get: () => ({
        open: async (id, access) => {
          assert.equal(access, 'read');
          const { header, events } = source(id);
          return {
            header,
            inheritedEventCount: 0,
            read: async (a, n) => ({ events: events.slice(a, a + n) }),
            close: async () => {},
          };
        },
      }),
      sessionQuery: {
        listSessions: async () => sessions,
        observeSession: async () => assert.fail('Fixture uses cold ranges'),
        readSession: async () => assert.fail('Fixture uses ranged persistence'),
        readEvent: async ({ sessionId, seq }) => {
          const { header, events } = source(sessionId);
          assert.ok(events[seq]);
          return { session: header, inheritedEventCount: 0, target: events[seq] };
        },
      },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      on: (_name, listener) => {
        publish = listener;
      },
      effect: () => {},
    };
    dispose = applyRuntime(
      ctx,
      snapshotConfig(
        Config({
          nodePath,
          dataPath: join(root, 'index'),
          envFile,
          sessionIds: [...sources.keys()],
          ...config,
        }),
      ),
      diagnostics,
    );
    return caller(tools);
  }
  function commit(id: string, event: SessionEvent) {
    const { header, events } = source(id);
    assert.equal(event.seq, events.length);
    events.push(event);
    assert.ok(publish);
    publish({ id, header }, event);
  }
  return { start, close, commit, requests, rejected, server };
}

async function waitForStatus(
  call: ReturnType<typeof caller>,
  predicate: (state: ToolResults['status']) => boolean,
) {
  const signal = AbortSignal.timeout(15_000);
  while (true) {
    // Do not invoke a tool action that could catch up text or vectors itself.
    const state = await call('status', {}, signal);
    if (predicate(state)) return state;
    await delay(150, undefined, { signal });
  }
}

test(
  'semantic search embeds its new text once and reuses frozen continuations',
  { timeout: 30_000 },
  async (t) => {
    const events = [message(0, 'rocket'), message(1, 'ocean'), message(2, 'forest')];
    const { requests, start } = await embeddingFixture(t, [session('fixture', events)]);
    const reports: Parameters<RuntimeDiagnostics['onTiming']>[0][] = [];
    const call = start(
      { embeddingSessionIds: ['fixture'], autoSync: false },
      { onTiming: (report) => reports.push(report) },
    );
    const first = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
    });
    assert.equal(first.hits.length, 1);
    assert.equal(first.presentation.comparison.top3.length, 3);
    assert.ok(first.nextCursor);
    const second = await call('search', {
      query: 'rocket question',
      mode: 'semantic',
      scope: 'fixture',
      cursor: first.nextCursor,
      limit: 5,
    });
    assert.equal(second.hits.length, 2);
    assert.deepEqual(
      requests.map((batch) => [...batch].sort()),
      [['forest', 'ocean', 'rocket'], ['rocket question']],
    );
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
    assert.deepEqual(
      requests.slice(beforeIncrement).map((batch) => [...batch].sort()),
      [['rocket assistant tail', 'rocket user tail'], ['rocket question']],
    );
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
  },
);

test(
  'autoEmbed is opt-in, yields during backfill and embeds only authorized new text',
  { timeout: 40_000 },
  async (t) => {
    const history = Array.from({ length: 33 }, (_, i) => `history ${i}`);
    const allowed = session('allowed', [message(0, history)]);
    const f = await embeddingFixture(t, [
      session('delegated', [message(0, 'subagent history')], 'subagent'),
      allowed,
      session('peer', [message(0, 'peer text')]),
      session('local', [message(0, 'local-only history')]),
    ]);
    const scope = { embeddingSessionIds: ['delegated', 'allowed', 'peer'] };
    const defaults = f.start(scope);
    const before = await waitForStatus(defaults, (s) => cursor(s, 'local') === 0);
    assert.equal(before.autoEmbed, false);
    assert.equal(before.embedding.configured, true, 'manual embedding remains available');
    assert.deepEqual([before.counts.blocks, before.counts.vectors], [35, 0]);
    await f.close();
    assert.equal(f.requests.length, 0);

    // Reopen already-indexed text: no fresh event can account for this backfill.
    const call = f.start({ ...scope, autoEmbed: true });
    const ready = await waitForStatus(call, (s) => s.counts.vectors >= 34);
    assert.equal(ready.autoEmbed, true);
    assert.deepEqual([ready.counts.vectors, ready.embedding.pendingBlocks], [34, 1]);
    assert.deepEqual(
      f.requests.map((batch) => batch.length),
      [32, 1, 1],
    );
    assert.deepEqual(f.requests[1], ['peer text'], 'the peer runs before the last history chunk');
    assert.deepEqual(f.requests.flat().sort(), [...history, 'peer text'].sort());

    f.commit('delegated', message(1, 'new subagent text'));
    f.commit('local', message(1, 'new local-only text'));
    f.commit('allowed', message(1, 'new authorized reply', 'assistant'));
    const tail = await waitForStatus(
      call,
      (s) => cursor(s, 'local') === 1 && s.counts.vectors >= 35,
    );
    assert.deepEqual(
      [cursor(tail, 'allowed'), cursor(tail, 'delegated'), tail.counts.vectors],
      [1, undefined, 35],
    );
    assert.deepEqual(f.requests.slice(3), [['new authorized reply']]);

    // A foreground read can see text before its queued event notification arrives.
    allowed.events.push(message(2, 'new text read first'));
    const result = await call(
      'read',
      { ref: 'allowed:2', before: 0, after: 0 },
      AbortSignal.timeout(5_000),
    );
    assert.equal(result.text, 'new text read first');
    assert.equal(result.verified, true);
    const afterRead = await waitForStatus(call, (s) => s.counts.vectors >= 36);
    assert.deepEqual(afterRead.autoEmbedErrors, []);
    assert.deepEqual(f.requests.slice(3), [['new authorized reply'], ['new text read first']]);
  },
);

test(
  'background HTTP failure retains local text and waits for new text before retrying',
  { timeout: 40_000 },
  async (t) => {
    const f = await embeddingFixture(t, [
      session('retry', [message(0, 'completed text')]),
      session('local', [message(0, 'local peer')]),
    ]);
    const failing = 'new text rejected by the provider';
    const call = f.start({ embeddingSessionIds: ['retry'], autoEmbed: true });
    await waitForStatus(call, (s) => cursor(s, 'local') === 0 && s.counts.vectors === 1);

    f.rejected.add(failing);
    f.commit('retry', message(1, failing));
    const failed = await waitForStatus(call, (s) => s.autoEmbedErrors.length > 0);
    const errors = [{ sessionId: 'retry', code: 'HTTP_ERROR' }];
    assert.deepEqual(failed.autoEmbedErrors, errors);
    assert.equal(cursor(failed, 'retry'), 1, 'text was checkpointed before the failed request');
    assert.equal(failed.counts.vectors, 1);
    for (const privateText of [EMBEDDING_KEY, EMBEDDING_ERROR, failing])
      assert.ok(!JSON.stringify(failed).includes(privateText));

    f.commit('retry', {
      seq: 2,
      time: 3,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    f.commit('local', message(1, 'local peer advances'));
    const idle = await waitForStatus(
      call,
      (s) => cursor(s, 'retry') === 2 && cursor(s, 'local') === 1 && !s.dirtySessions,
    );
    assert.deepEqual(idle.autoEmbedErrors, errors);
    assert.deepEqual(idle.syncErrors, []);
    // A negative observation over two scheduling intervals, not a readiness sleep.
    await assert.rejects(once(f.server, 'request', { signal: AbortSignal.timeout(650) }), {
      name: 'AbortError',
    });
    assert.deepEqual([...f.requests], [['completed text'], [failing]]);

    f.rejected.delete(failing);
    f.commit('retry', message(3, 'new visible reply', 'assistant'));
    const recovered = await waitForStatus(
      call,
      (s) => s.counts.vectors >= 3 && !s.autoEmbedErrors.length,
    );
    assert.equal(cursor(recovered, 'retry'), 3);
    assert.deepEqual(
      f.requests.slice(2).map((batch) => [...batch].sort()),
      [[failing, 'new visible reply']],
    );
  },
);
