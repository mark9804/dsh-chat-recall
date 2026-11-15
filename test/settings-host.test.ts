import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Config, apply } from '../dist/host/plugin.js';
import { snapshotConfig } from '../dist/host/config.js';
import type { PluginConfig } from '../dist/host/types.js';
import type {
  HostContext,
  LiveSession,
  RuntimeFiber,
  SessionEvent,
  SessionQuery,
  SettingsHostContext,
  SubprocessHandle,
  SubprocessService,
  ToolDefinition,
} from '../dist/host/contracts.js';

const gate = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const plain = (patch: Partial<PluginConfig> = {}): PluginConfig =>
  snapshotConfig(
    Config({
      dataPath: '/synthetic/chat-recall',
      autoSync: false,
      ...patch,
    }),
  );
class Ref<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  get(): T {
    return this.value;
  }
}
function refs(config = plain()) {
  return {
    nodePath: new Ref(config.nodePath),
    dataPath: new Ref(config.dataPath),
    sessionIds: new Ref(config.sessionIds),
    embeddingSessionIds: new Ref(config.embeddingSessionIds),
    envFile: new Ref(config.envFile),
    callerSessionIds: new Ref(config.callerSessionIds),
    autoSync: new Ref(config.autoSync),
    dominantMin: new Ref(config.dominantMin),
    dominantGap: new Ref(config.dominantGap),
  };
}

test('Host Config retains flat volatile paths, safe defaults and plain saved values', () => {
  const parsed = Config({});
  assert.equal(Config.type, 'object');
  assert.deepEqual(Object.keys(Config.dict ?? {}).sort(), [
    'autoSync',
    'callerSessionIds',
    'dataPath',
    'dominantGap',
    'dominantMin',
    'embeddingSessionIds',
    'envFile',
    'nodePath',
    'sessionIds',
  ]);
  for (const field of Object.values(Config.dict ?? {})) assert.equal(field.meta.volatile, true);
  assert.deepEqual(parsed.sessionIds.get(), []);
  assert.deepEqual(parsed.embeddingSessionIds.get(), []);
  assert.deepEqual(parsed.callerSessionIds.get(), []);
  assert.equal(parsed.envFile.get(), undefined);
  assert.equal(parsed.nodePath.get(), 'node');
  assert.equal(parsed.autoSync.get(), true);
  assert.equal(parsed.dominantMin.get(), 0.5);
  assert.equal(parsed.dominantGap.get(), 0.15);
  assert.deepEqual(Config.simplify(Config({ sessionIds: ['fixture'], autoSync: false })), {
    sessionIds: ['fixture'],
    autoSync: false,
  });
  // Serializing the settings description has no runtime/service dependency.
  assert.ok(JSON.stringify(Config).includes('volatile'));
});

test('Config normalizes selections and validates all/corpus embedding semantics', () => {
  const parsed = snapshotConfig(
    Config({
      nodePath: ' node ',
      sessionIds: [' fixture ', 'fixture', 'other'],
      embeddingSessionIds: ['fixture', ' fixture '],
      callerSessionIds: [' caller ', 'caller'],
    }),
  );
  assert.equal(parsed.nodePath, 'node');
  assert.deepEqual(parsed.sessionIds, ['fixture', 'other']);
  assert.deepEqual(parsed.embeddingSessionIds, ['fixture']);
  assert.deepEqual(parsed.callerSessionIds, ['caller']);
  for (const input of [
    { sessionIds: ['all', 'fixture'] },
    { embeddingSessionIds: ['all', 'fixture'], sessionIds: ['all'] },
    { embeddingSessionIds: ['fixture'] },
    { embeddingSessionIds: ['all'] },
    { sessionIds: ['fixture'], embeddingSessionIds: ['other'] },
    { callerSessionIds: ['all'] },
    { sessionIds: ['  '] },
  ])
    assert.throws(() => Config(input));
  assert.doesNotThrow(() => Config({ sessionIds: ['fixture'], embeddingSessionIds: ['all'] }));
  assert.doesNotThrow(() => Config({ sessionIds: ['all'], embeddingSessionIds: ['fixture'] }));
  assert.doesNotThrow(() => Config({ sessionIds: ['all'], embeddingSessionIds: ['all'] }));
});

test('Config rejects unsafe paths, empty Node and invalid numeric/schema inputs before activation', () => {
  const invalid: unknown[] = [
    { dataPath: 'relative' },
    { dataPath: '' },
    { dataPath: '/tmp/\0fixture' },
    { envFile: './secrets' },
    { envFile: '' },
    { envFile: '/tmp/\0fixture.env' },
    { nodePath: '' },
    { nodePath: '  ' },
    { nodePath: 'node\0x' },
    { dominantMin: -0.1 },
    { dominantMin: 1.1 },
    { dominantGap: 2.1 },
    { dominantGap: -0.1 },
    { autoSync: 'true' },
    { sessionIds: [null] },
  ];
  for (const input of invalid) {
    const result = Config['~standard'].validate(input);
    assert.ok(!('then' in result));
    assert.ok(result.issues, JSON.stringify(input));
  }
  const result = Config['~standard'].validate({
    sessionIds: ['fixture'],
    embeddingSessionIds: ['other'],
  });
  assert.ok(!('then' in result));
  assert.deepEqual(result.issues?.[0]?.path, ['embeddingSessionIds']);
});

test('runtime snapshots support plain configs and refs without sharing mutable selections', () => {
  const config = plain({ sessionIds: ['fixture'] });
  const first = snapshotConfig(config);
  config.sessionIds.push('new');
  assert.deepEqual(first.sessionIds, ['fixture']);
  const live = refs(config);
  const next = snapshotConfig(live);
  live.sessionIds.value.push('later');
  assert.deepEqual(next.sessionIds, ['fixture', 'new']);
});

type Dispose = () => void | Promise<void>;
type SessionListener = (session: LiveSession, event: SessionEvent) => void;
type VolatileListener = (paths: readonly (readonly string[])[]) => void;
type SpawnSpec = Parameters<SubprocessService['spawn']>[0];
interface Request {
  id: number;
  method: string;
  params: unknown;
}
interface FakeProcess extends SubprocessHandle {
  spec: SpawnSpec;
  requests: Request[];
  alive: boolean;
  holdStatus: boolean;
  exitConfirmed: boolean;
  exitBarrier?: Promise<void>;
}
class Processes implements SubprocessService {
  handles: FakeProcess[] = [];
  maximumAlive = 0;
  resolves: string[] = [];
  async resolveExecutable(value: string): Promise<string> {
    this.resolves.push(value);
    return value;
  }
  spawn(spec: SpawnSpec): FakeProcess {
    assert.ok(
      this.handles.every((handle) => !handle.alive),
      'old worker exited before spawn',
    );
    const exit = gate();
    const handle: FakeProcess = {
      spec,
      requests: [],
      alive: true,
      holdStatus: false,
      exitConfirmed: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: exit.promise,
      terminate() {
        handle.alive = false;
        exit.resolve();
      },
      async waitForExit() {
        await exit.promise;
        await handle.exitBarrier;
        return handle.exitConfirmed;
      },
    };
    handle.stdin.on('finish', () => handle.terminate());
    handle.stdin.on('data', (bytes: Buffer) => {
      for (const line of bytes.toString().trim().split('\n')) {
        const request = JSON.parse(line) as Request;
        handle.requests.push(request);
        if (request.method === 'status' && handle.holdStatus) continue;
        const value = request.method === 'status' ? { checkpoints: [] } : {};
        handle.stdout.push(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
      }
    });
    this.handles.push(handle);
    this.maximumAlive = Math.max(
      this.maximumAlive,
      this.handles.filter((process) => process.alive).length,
    );
    handle.stdout.push(
      `${JSON.stringify({
        type: 'ready',
        protocol: 1,
        pid: this.handles.length,
        node: 'v24.22.1',
        lancedb: '0.0.0-fixture',
      })}\n`,
    );
    return handle;
  }
}
class Context implements SettingsHostContext {
  fiber = { uid: 1 as number | null, state: 2 };
  tools: HostContext['tools'];
  sessions = { get: () => undefined };
  subprocess: Processes;
  sessionQuery: SessionQuery;
  registered: Map<string, ToolDefinition>;
  children: Context[] = [];
  effects: Dispose[] = [];
  sessionListeners = new Set<SessionListener>();
  volatileListeners = new Set<VolatileListener>();
  policies: { auto: boolean; owner: SettingsHostContext['fiber'] }[] = [];
  policyDisposals = 0;
  errors: unknown[] = [];
  logger = {
    warn: (error: unknown) => {
      this.errors.push(error);
    },
  };
  discoveryReads = 0;
  discovery?: Promise<{ header: { id: string; createdAt: number } }[]>;
  constructor(processes = new Processes(), tools = new Map<string, ToolDefinition>()) {
    this.subprocess = processes;
    this.registered = tools;
    this.tools = {
      register: (definition) => {
        assert.ok(!tools.has(definition.name), 'tool registrations never overlap');
        tools.set(definition.name, definition);
        this.effects.push(() => {
          if (tools.get(definition.name) === definition) tools.delete(definition.name);
        });
      },
    };
    this.sessionQuery = {
      listSessions: async () => {
        this.discoveryReads++;
        return this.discovery ?? [];
      },
      observeSession: async () => {
        throw new Error('unexpected observation');
      },
      readSession: async () => {
        throw new Error('unexpected read');
      },
      readEvent: async () => {
        throw new Error('unexpected read');
      },
    };
  }
  effect(factory: () => () => Promise<void>): void {
    this.effects.push(factory());
  }
  on(event: 'loader/volatile-update', listener: VolatileListener): void;
  on(event: 'session/event', listener: SessionListener): void;
  on(
    event: 'loader/volatile-update' | 'session/event',
    listener: VolatileListener | SessionListener,
  ): void {
    if (event === 'loader/volatile-update') {
      const callback = listener as VolatileListener;
      this.volatileListeners.add(callback);
      this.effects.push(() => {
        this.volatileListeners.delete(callback);
      });
    } else {
      const callback = listener as SessionListener;
      this.sessionListeners.add(callback);
      this.effects.push(() => {
        this.sessionListeners.delete(callback);
      });
    }
  }
  inject(
    services: ['settings'],
    callback: Parameters<NonNullable<SettingsHostContext['inject']>>[1],
  ): void {
    assert.deepEqual(services, ['settings']);
    callback({
      settings: {
        configure: (presentation, owner) => {
          this.policies.push({ ...presentation, owner });
          return () => {
            this.policyDisposals++;
          };
        },
      },
      effect: (factory) => {
        this.effects.push(factory());
      },
    });
  }
  plugin(callback: (ctx: HostContext) => void): RuntimeFiber {
    const child = new Context(this.subprocess, this.registered);
    child.sessionQuery = this.sessionQuery;
    this.children.push(child);
    const ready = Promise.resolve().then(() => {
      if (child.fiber.uid !== null) callback(child);
    });
    let disposing: Promise<void> | undefined;
    const dispose = () => {
      if (disposing) return disposing;
      child.fiber.uid = null;
      child.fiber.state = 5;
      // Cordis owns children and logs (rather than propagating) effect cleanup failures.
      disposing = ready
        .then(() => child.cleanup())
        .catch((error: unknown) => {
          this.errors.push(error);
        });
      return disposing;
    };
    this.effects.push(dispose);
    return { dispose, await: () => ready };
  }
  update(): void {
    for (const callback of this.volatileListeners) callback([['nodePath']]);
  }
  async cleanup(): Promise<void> {
    const results = await Promise.allSettled(
      this.effects
        .splice(0)
        .reverse()
        .map((dispose) => dispose()),
    );
    for (const result of results) if (result.status === 'rejected') this.errors.push(result.reason);
  }
  async dispose(): Promise<void> {
    this.fiber.uid = null;
    this.fiber.state = 5;
    await this.cleanup();
  }
  call(name = 'status'): Promise<unknown> {
    const definition = this.registered.get(`chat_recall_${name}`);
    assert.ok(definition);
    return definition.execute(
      {},
      { agent: { id: 'caller' }, signal: new AbortController().signal },
    );
  }
}

test('defaults register settings ownership without reading sessions or starting a worker', async () => {
  const ctx = new Context();
  apply(ctx, Config({}));
  await flush();
  assert.equal(ctx.registered.size, 4);
  assert.equal(ctx.discoveryReads, 0);
  assert.equal(ctx.subprocess.handles.length, 0);
  assert.equal(ctx.subprocess.resolves.length, 0);
  assert.deepEqual(ctx.policies, [{ auto: false, owner: ctx.fiber }]);
  await ctx.dispose();
  assert.equal(ctx.policyDisposals, 1);
  assert.equal(ctx.registered.size, 0);
  assert.equal(ctx.children[0].sessionListeners.size, 0);
});

test('plain legacy contexts still run directly without optional lifecycle/settings APIs', async () => {
  const ctx = new Context();
  const legacy: HostContext = {
    tools: ctx.tools,
    subprocess: ctx.subprocess,
    sessionQuery: ctx.sessionQuery,
    sessions: ctx.sessions,
    on: () => {},
    effect: (factory) => ctx.effect(factory),
  };
  apply(legacy, plain());
  assert.equal(ctx.registered.size, 4);
  assert.equal(ctx.children.length, 0);
  await ctx.dispose();
});

test('volatile reload aborts pending work, awaits confirmed exit, coalesces and uses committed values', async () => {
  const ctx = new Context();
  const config = refs();
  apply(ctx, config);
  await flush();
  await ctx.call();
  const oldTool = ctx.registered.get('chat_recall_status')!;
  const process = ctx.subprocess.handles[0];
  process.holdStatus = true;
  const exit = gate();
  process.exitBarrier = exit.promise;
  const pending = ctx.call();
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.ok(['ABORT_ERR', 'BRIDGE_CLOSED', 'CLOSED'].includes(String(error.code)));
    return true;
  });
  await flush();
  config.nodePath.value = 'new-node';
  config.dataPath.value = '/synthetic/new-index';
  config.envFile.value = '/synthetic/new.env';
  config.sessionIds.value = ['selected'];
  config.embeddingSessionIds.value = ['all'];
  config.dominantMin.value = 0.7;
  config.dominantGap.value = 0.25;
  ctx.update();
  await rejected;
  await assert.rejects(
    oldTool.execute({}, { agent: { id: 'caller' }, signal: new AbortController().signal }),
    { code: 'CLOSED' },
  );
  await flush();
  assert.equal(ctx.children.length, 1, 'waits for subprocess quiescence');
  assert.equal(ctx.registered.size, 0);
  config.nodePath.value = 'latest-node';
  ctx.update();
  ctx.update();
  await flush();
  assert.equal(ctx.children.length, 1);
  exit.resolve();
  await flush();
  assert.equal(ctx.children.length, 2, 'intermediate snapshots never mount');
  assert.equal(ctx.registered.size, 4);
  assert.equal(ctx.subprocess.handles.length, 1, 'replacement is lazy');
  await ctx.call();
  const next = ctx.subprocess.handles[1];
  assert.equal(next.spec.argv[0], 'latest-node');
  assert.ok(next.spec.argv.includes('--env-file=/synthetic/new.env'));
  assert.equal(next.spec.argv.at(-1), '/synthetic/new-index');
  assert.deepEqual(next.requests[0], {
    id: 1,
    method: 'configure',
    params: { embeddingEnabled: true, candidatePolicy: { dominantMin: 0.7, dominantGap: 0.25 } },
  });
  assert.equal(ctx.subprocess.maximumAlive, 1);
  assert.equal(ctx.policies.length, 1);
  await ctx.dispose();
  assert.ok(ctx.subprocess.handles.every((handle) => !handle.alive));
  assert.equal(ctx.registered.size, 0);
});

test('updates racing async child activation and disposal cannot activate stale runtimes', async () => {
  const ctx = new Context();
  const config = refs();
  apply(ctx, config);
  const late = [...ctx.volatileListeners][0];
  config.callerSessionIds.value = ['new-caller'];
  ctx.update();
  await flush();
  assert.equal(ctx.children[0].sessionListeners.size, 0);
  assert.equal(ctx.registered.size, 4);
  await assert.rejects(ctx.call(), { code: 'OUT_OF_SCOPE' });
  await ctx.dispose();
  const count = ctx.children.length;
  late([['callerSessionIds']]);
  await flush();
  assert.equal(ctx.children.length, count);
  assert.equal(ctx.registered.size, 0);
  assert.equal(ctx.subprocess.handles.length, 0);
});

test('disposal during delayed discovery fences initialization and queued replacements', async () => {
  const ctx = new Context();
  const discovery = gate<{ header: { id: string; createdAt: number } }[]>();
  ctx.discovery = discovery.promise;
  const config = refs(plain({ autoSync: true, sessionIds: ['all'] }));
  apply(ctx, config);
  await flush();
  const old = ctx.registered.get('chat_recall_status')!;
  config.autoSync.value = false;
  ctx.update();
  const closing = ctx.dispose();
  discovery.resolve([{ header: { id: 'fixture', createdAt: 1 } }]);
  await closing;
  await flush();
  assert.equal(ctx.children.length, 1);
  assert.equal(ctx.registered.size, 0);
  assert.equal(ctx.subprocess.handles.length, 0);
  await assert.rejects(
    old.execute({}, { agent: { id: 'caller' }, signal: new AbortController().signal }),
    { code: 'CLOSED' },
  );
});

test('failed worker quiescence fails closed even when Cordis swallows cleanup errors', async () => {
  const ctx = new Context();
  const config = refs();
  apply(ctx, config);
  await flush();
  await ctx.call();
  ctx.subprocess.handles[0].exitConfirmed = false;
  config.nodePath.value = 'replacement';
  ctx.update();
  await flush();
  ctx.update();
  await flush();
  assert.equal(ctx.children.length, 1);
  assert.equal(ctx.registered.size, 0);
  assert.ok(
    ctx.errors.some(
      (error) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_SHUTDOWN_FAILED',
    ),
  );
  await ctx.dispose();
});
