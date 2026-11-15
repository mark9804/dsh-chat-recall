import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSync, eventHash } from '../dist/host/sync.js';
import type { HostContext, SessionEvent } from '../dist/host/contracts.js';
import type { SessionRow, SyncBatch, VisibleBlock } from '../dist/shared/model.js';
import type { Method, Params, Result, WorkerCall } from '../dist/shared/protocol.js';

const event = (seq: number, text = `text-${seq}`): SessionEvent => ({
  seq,
  time: seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: {
    id: `source-${seq}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  },
});

function fixture({ live = true, persisted = true, origin = 'main' } = {}) {
  const events = [event(0), event(1)];
  const header = {
    id: 's',
    cwd: '/fixture',
    createdAt: 1,
    ...(origin === 'subagent' ? { origin } : {}),
  };
  const state = new Map<string, SessionRow>(),
    reads: [number, number][] = [],
    writes: SyncBatch[] = [];
  let closed = 0;
  const session = {
    header,
    inheritedEventCount: 1,
    get seq() {
      return events.length;
    },
    snapshotEvents(a: number, b: number) {
      reads.push([a, b - a]);
      return events.slice(a, b);
    },
  };
  const request: WorkerCall = async <M extends Method>(
    method: M,
    p: Params<M>,
  ): Promise<Result<M>> => {
    if (method === 'checkpoints') return { sessions: [...state.values()] } as Result<M>;
    assert.equal(method, 'sync');
    const batch = p as Params<'sync'>;
    writes.push(batch);
    state.set(batch.session.sessionId, batch.session);
    return {
      session: batch.session,
      messages: batch.messages.length,
      blocks: batch.blocks.length,
      changed: true,
    } as Result<M>;
  };
  const ctx = {
    sessions: { get: () => (live ? session : undefined) },
    sessionQuery: {
      observeSession: async () => ({
        header,
        inheritedEventCount: 1,
        cursor: events.length - 1,
        events: { slice: (a: number, b: number) => session.snapshotEvents(a, b) },
        [Symbol.dispose]() {},
      }),
      readTitle: async () => ({ title: 'Fixture' }),
      listSessions: async () => [{ header }],
      readSession: async () => ({ session: header, events, inheritedEventCount: 1 }),
    },
    get: (key: string) =>
      key === 'sessionPersistence' && persisted
        ? {
            open: async (_id: string, access: string) => {
              assert.equal(access, 'read');
              return {
                header,
                inheritedEventCount: 1,
                read: async (a: number, n: number) => {
                  reads.push([a, n]);
                  return { events: events.slice(a, a + n) };
                },
                close: async () => {
                  closed++;
                },
              };
            },
          }
        : undefined,
  };
  return {
    events,
    header,
    state,
    reads,
    writes,
    request,
    ctx: ctx as unknown as HostContext,
    closed: () => closed,
  };
}

test('sync only tail after checkpoint and preserves inherited coordinates', async () => {
  const f = fixture();
  const sync = new SessionSync({ ctx: f.ctx, request: f.request, sessionIds: ['s'] });
  const a = await sync.sync('s');
  assert.equal(a.eventsRead, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(
    (JSON.parse(f.writes[0].messages[0].contentJson) as VisibleBlock[])[0].inherited,
    true,
  );
  f.events.push(event(2));
  f.reads.length = 0;
  const b = await sync.sync('s');
  assert.equal(b.eventsRead, 1);
  assert.deepEqual(f.reads, [
    [1, 1],
    [2, 1],
  ]);
  assert.equal(f.writes[1].blocks[0].eventSeq, 2);
  assert.equal(
    (JSON.parse(f.writes[1].messages[0].contentJson) as VisibleBlock[])[0].inherited,
    false,
  );
  const c = await sync.sync('s');
  assert.equal(c.eventsRead, 0);
  assert.equal(f.writes.length, 2);
  await sync.close();
});

test('cold persistence read is ranged, read-only and closes its handle', async () => {
  const f = fixture({ live: false });
  const sync = new SessionSync({ ctx: f.ctx, request: f.request, sessionIds: ['s'] });
  await sync.sync('s');
  assert.equal(f.closed(), 1);
  f.events.push(event(2));
  f.reads.length = 0;
  await sync.sync('s');
  assert.equal(f.closed(), 2);
  assert.deepEqual(f.reads, [
    [1, 1],
    [2, 256],
  ]);
  await sync.close();
});

test('changed anchor rejects rather than silently rewriting source', async () => {
  const f = fixture();
  const sync = new SessionSync({ ctx: f.ctx, request: f.request, sessionIds: ['s'] });
  await sync.sync('s');
  f.events[1] = event(1, 'changed');
  await assert.rejects(sync.sync('s'), { code: 'SOURCE_CHANGED' });
  assert.equal(f.writes.length, 1);
  await sync.close();
});

test('failed write does not advance local cursor and next sync replays', async () => {
  const f = fixture();
  let failed = false;
  const sync = new SessionSync({
    ctx: f.ctx,
    sessionIds: ['s'],
    request: async (method, p) => {
      if (method === 'sync' && !failed) {
        failed = true;
        throw new Error('simulated');
      }
      return f.request(method, p);
    },
  });
  await assert.rejects(sync.sync('s'));
  assert.equal(f.state.size, 0);
  await sync.sync('s');
  const checkpoint = f.state.get('s');
  assert.ok(checkpoint);
  assert.equal(checkpoint.anchorHash, eventHash(f.events[1]));
  await sync.close();
});

test('a concurrent sync catches events appended after the first fixed snapshot', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const sync = new SessionSync({
    ctx: f.ctx,
    sessionIds: ['s'],
    request: async (method, p) => {
      if (method === 'sync' && first) {
        first = false;
        entered();
        await barrier;
      }
      return f.request(method, p);
    },
  });
  const a = sync.sync('s');
  await started;
  f.events.push(event(2));
  const b = sync.sync('s');
  release();
  await a;
  await b;
  const checkpoint = f.state.get('s');
  assert.ok(checkpoint);
  assert.equal(checkpoint.cursor, 2);
  await sync.close();
});

test('configured scope and subagent exclusion apply before indexing', async () => {
  const f = fixture({ origin: 'subagent' });
  const sync = new SessionSync({ ctx: f.ctx, request: f.request, sessionIds: ['s'] });
  await assert.rejects(sync.sync('other'), { code: 'OUT_OF_SCOPE' });
  assert.equal((await sync.sync('s')).skipped, 'subagent');
  assert.equal(f.writes.length, 0);
  await sync.close();
});
