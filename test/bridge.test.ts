import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WorkerBridge, type BridgeOptions } from '../dist/host/bridge.js';
import type { SubprocessHandle, SubprocessService } from '../dist/host/contracts.js';
import { captureTiming } from '../dist/shared/timing.js';

const NODE = process.env.RECALL_TEST_NODE ?? process.execPath;
const WORKER = fileURLToPath(new URL('./fixtures/bridge-worker.ts', import.meta.url));
const CWD = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE = 'fixture-private-value';
const ready = {
  type: 'ready',
  protocol: 1,
  pid: 12345,
  node: 'v24.22.1',
  lancedb: '0.0.0-fixture',
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const gate = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
type Exit = { exitCode: number | null; signal: NodeJS.Signals | null };
interface InstrumentedHandle extends SubprocessHandle {
  terminated: number;
  waited: number;
  alive: boolean;
  pid?: number;
}
type ResolveArgs = Parameters<SubprocessService['resolveExecutable']>;
type SpawnOptions = Parameters<SubprocessService['spawn']>[0];
interface ServiceOverrides {
  resolve?: (...args: ResolveArgs) => string | Promise<string>;
  spawn?: (options: SpawnOptions) => InstrumentedHandle | Promise<InstrumentedHandle>;
}
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, code);
    assert.ok(!String(error).includes(PRIVATE));
    assert.equal(error.cause, undefined);
    return true;
  });

function mockHandle({ autoExit = true, autoTerminate = true } = {}) {
  const exit = gate<Exit>();
  const handle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done: exit.promise,
    terminated: 0,
    waited: 0,
    alive: true,
    terminate() {
      this.terminated++;
      if (autoTerminate) this.exit();
    },
    async waitForExit() {
      this.waited++;
      await this.done;
      return !this.alive;
    },
    exit() {
      if (!this.alive) return;
      this.alive = false;
      this.stdout.end();
      this.stderr.end();
      exit.resolve({ exitCode: 0, signal: null });
    },
  };
  if (autoExit) handle.stdin.on('finish', () => handle.exit());
  return handle;
}

/** Direct command completion and managed-range quiescence are independent. */
function splitRangeHandle() {
  const direct = gate<Exit>();
  const range = gate<boolean>();
  const termination = gate<void>();
  // A deliberate observation failure may precede the bridge's observer.
  void range.promise.catch(() => {});
  let directAlive = true;
  let rangeAlive = true;
  const handle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done: direct.promise,
    terminated: 0,
    waited: 0,
    get alive() {
      return directAlive || rangeAlive;
    },
    terminate() {
      this.terminated++;
      termination.resolve();
      // Signalling starts teardown; only the independent observer confirms it.
    },
    async waitForExit() {
      this.waited++;
      return range.promise;
    },
    exitDirect() {
      directAlive = false;
      direct.resolve({ exitCode: 0, signal: null });
    },
    exitRange() {
      rangeAlive = false;
      this.stdout.end();
      this.stderr.end();
      range.resolve(true);
    },
    failObservation() {
      range.reject(new Error(PRIVATE));
    },
    termination: termination.promise,
  };
  return handle;
}

function mockService({ resolve, spawn: start }: ServiceOverrides = {}) {
  const service = {
    resolves: [] as ResolveArgs[],
    spawns: [] as SpawnOptions[],
    handles: [] as InstrumentedHandle[],
    async resolveExecutable(...args: ResolveArgs) {
      this.resolves.push(args);
      return resolve ? resolve(...args) : args[0];
    },
    async spawn(options: SpawnOptions) {
      this.spawns.push(options);
      const handle = start ? await start(options) : mockHandle();
      this.handles.push(handle);
      return handle;
    },
  };
  return service;
}

function realService() {
  const service = mockService({
    spawn(options): InstrumentedHandle {
      const child = spawn(options.argv[0], options.argv.slice(1), {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      const exit = gate<Exit>();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let alive = true;
      child.on('error', () => {});
      child.once('close', (exitCode, signal) => {
        alive = false;
        clearTimeout(killTimer);
        exit.resolve({ exitCode, signal });
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done: exit.promise,
        terminated: 0,
        waited: 0,
        pid: child.pid,
        get alive() {
          return alive;
        },
        terminate() {
          this.terminated++;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), options.graceMs);
        },
        async waitForExit() {
          this.waited++;
          await exit.promise;
          return !alive;
        },
      };
    },
  });
  return service;
}

function bridgeFor(
  t: TestContext,
  service = realService(),
  overrides: Partial<BridgeOptions> = {},
) {
  const bridge = new WorkerBridge({
    subprocess: service,
    nodePath: NODE,
    workerPath: WORKER,
    cwd: CWD,
    dataPath: 'normal',
    requestTimeoutMs: 3_000,
    ...overrides,
  });
  t.after(async () => {
    await bridge.close();
    for (const handle of service.handles) assert.equal(handle.alive, false, 'no leaked child');
  });
  return { bridge, service };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('requires an explicit child Node; invalid configuration never starts a process', () => {
  const subprocess = mockService();
  const options = { subprocess, nodePath: NODE, workerPath: WORKER, cwd: CWD, dataPath: 'normal' };
  for (const overrides of [
    { nodePath: undefined },
    { nodePath: '' },
    { requestTimeoutMs: 0 },
    { envFile: '' },
  ]) {
    assert.throws(
      () => new WorkerBridge({ ...options, ...overrides } as unknown as BridgeOptions),
      { code: 'INVALID_REQUEST' },
    );
  }
  assert.equal(subprocess.spawns.length, 0);
});

test('status is local, close is idempotent, and closed requests cannot start a child', async (t) => {
  const { bridge, service } = bridgeFor(t, mockService());
  assert.deepEqual(bridge.status(), {
    state: 'idle',
    ready: null,
    pending: 0,
    lastErrorCode: null,
  });
  assert.equal(service.resolves.length, 0);
  const closing = bridge.close();
  assert.equal(bridge.close(), closing);
  await closing;
  assert.equal(bridge.status().state, 'closed');
  await rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  assert.equal(service.spawns.length, 0);
});

test('one real worker multiplexes requests and shuts down cleanly', async (t) => {
  const { bridge, service } = bridgeFor(t);
  const [first, second, runtime] = await Promise.all([
    bridge.request('echo', { text: '一' }),
    bridge.request('echo', { text: '二' }),
    bridge.request('runtime'),
  ]);
  assert.deepEqual(first, { text: '一' });
  assert.deepEqual(second, { text: '二' });
  assert.ok(runtime !== null && typeof runtime === 'object');
  assert.ok('executable' in runtime && 'version' in runtime);
  assert.equal(runtime.executable, NODE);
  assert.equal(runtime.version, bridge.status().ready?.node);
  assert.equal(service.spawns.length, 1);
  assert.deepEqual(service.spawns[0], {
    argv: [NODE, WORKER, 'normal'],
    cwd: CWD,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 1_000,
  });
  assert.equal(bridge.status().state, 'ready');
  const status = bridge.status();
  assert.ok(status.ready);
  assert.equal(status.ready.pid, service.handles[0].pid);
  assert.equal(Reflect.get(status.ready, 'ignored'), undefined);
  const snapshot = bridge.status();
  assert.ok(snapshot.ready);
  snapshot.ready.pid = -1;
  assert.notEqual(bridge.status().ready?.pid, -1);
  const order: unknown[] = [];
  const slow = bridge.request('delay', { ms: 50, value: 'slow' }).then((value) => {
    order.push(value);
    return value;
  });
  const fast = bridge.request('echo', 'fast').then((value) => {
    order.push(value);
    return value;
  });
  assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast']);
  assert.deepEqual(order, ['fast', 'slow']);
  assert.equal(await bridge.request('fragment'), '你好，鲸鱼 🐳 café');
  await bridge.close();
  assert.equal(service.handles[0].terminated, 0, 'healthy worker exits on stdin EOF');
  assert.equal(service.handles[0].waited, 1);
});

test('diagnostics is opt-in, merges only allowlisted timing and leaves values unchanged', async (t) => {
  const handle = mockHandle();
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const written: Record<string, unknown>[] = [];
  handle.stdin.on('data', (data) =>
    written.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  const initial = bridge.request('echo');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  handle.stdout.write(line({ id: 1, ok: true, value: 'ordinary' }));
  assert.equal(await initial, 'ordinary');
  assert.equal(written[0].diagnostics, undefined);
  const captured = captureTiming(() => bridge.request('echo'));
  await flush();
  assert.equal(written[1].diagnostics, true);
  handle.stdout.write(
    line({
      id: 2,
      ok: true,
      value: 'unchanged',
      timing: {
        totalMs: 1,
        private: PRIVATE,
        spans: [{ name: 'embedding.http', ms: 0.5, count: 1, query: PRIVATE }],
      },
    }),
  );
  const result = await captured;
  assert.equal(result.value, 'unchanged');
  assert.equal(result.timing.spans.find((s) => s.name === 'embedding.http')?.ms, 0.5);
  assert.ok(!JSON.stringify(result.timing).includes(PRIVATE));
  const malformed = captureTiming(() => bridge.request('echo'));
  await flush();
  handle.stdout.write(
    line({
      id: 3,
      ok: true,
      value: 3,
      timing: { totalMs: 1, spans: [{ name: PRIVATE, ms: 1, count: 1 }] },
    }),
  );
  assert.equal((await malformed).value, 3);
});

test('env-file is passed as one argument only, without reading it or invoking a shell', async (t) => {
  const handle = mockHandle();
  const service = mockService({ resolve: () => '/resolved/independent-node', spawn: () => handle });
  const { bridge } = bridgeFor(t, service, {
    envFile: '/not-read/env path;$(unsafe)',
    dataPath: '/data path/;$(unsafe)',
  });
  const request = bridge.request('echo');
  await flush();
  assert.deepEqual(service.spawns[0].argv, [
    '/resolved/independent-node',
    '--env-file=/not-read/env path;$(unsafe)',
    WORKER,
    '/data path/;$(unsafe)',
  ]);
  assert.equal(Object.hasOwn(service.spawns[0], 'env'), false);
  handle.stdout.write(line(ready));
  await flush();
  handle.stdout.write(line({ id: 1, ok: true, value: {} }));
  await request;
});

test('no request is written before ready; split UTF-8 and coalesced out-of-order results work', async (t) => {
  const handle = mockHandle();
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const written: string[] = [];
  handle.stdin.on('data', (data) => written.push(data.toString()));
  const a = bridge.request('echo', { index: 1 });
  const b = bridge.request('echo', { index: 2 });
  await flush();
  assert.equal(written.length, 0);
  assert.equal(bridge.status().state, 'starting');
  for (const byte of Buffer.from(line(ready))) handle.stdout.write(Buffer.from([byte]));
  await flush();
  assert.deepEqual(
    written.map((text) => JSON.parse(text).id),
    [1, 2],
  );
  const response = Buffer.from(
    line({ id: 2, ok: true, value: '你好 🐳 café' }) + line({ id: 1, ok: true, value: 0 }),
  );
  for (const byte of response) handle.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await Promise.all([a, b]), [0, '你好 🐳 café']);
  assert.equal(bridge.status().pending, 0);
});

test('ready metadata does not admit raw runtime diagnostic text', async (t) => {
  const handle = mockHandle();
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const rejected = rejectsCode(bridge.request('echo'), 'WORKER_PROTOCOL_ERROR');
  await flush();
  handle.stdout.write(line({ ...ready, node: PRIVATE }));
  await rejected;
  assert.ok(!JSON.stringify(bridge.status()).includes(PRIVATE));
});

test('backend error and stderr never leak diagnostics, and request errors leave worker usable', async (t) => {
  const { bridge, service } = bridgeFor(t);
  await rejectsCode(bridge.request('fail'), 'VALIDATION_ERROR');
  assert.ok(!JSON.stringify(bridge.status()).includes(PRIVATE));
  await rejectsCode(bridge.request('bad-error'), 'WORKER_REQUEST_FAILED');
  await rejectsCode(bridge.request('uppercase-secret'), 'WORKER_REQUEST_FAILED');
  assert.ok(!JSON.stringify(bridge.status()).includes('PRIVATE_CREDENTIAL'));
  assert.equal(await bridge.request('stderr'), 'drained');
  assert.equal(await bridge.request('echo', null), null);
  assert.equal(service.spawns.length, 1);
});

test('pre-aborted and synchronously aborted requests do not even resolve Node', async (t) => {
  const { bridge, service } = bridgeFor(t, mockService());
  const already = AbortSignal.abort(new Error(PRIVATE));
  await rejectsCode(bridge.request('echo', {}, already), 'ABORT_ERR');
  const controller = new AbortController();
  const request = bridge.request('echo', {}, controller.signal);
  controller.abort(PRIVATE);
  await rejectsCode(request, 'ABORT_ERR');
  await flush();
  assert.equal(service.resolves.length, 0);
  assert.equal(service.spawns.length, 0);
});

test('invalid requests do not start the worker', async (t) => {
  const { bridge, service } = bridgeFor(t, mockService());
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  await rejectsCode(bridge.request(''), 'INVALID_REQUEST');
  await rejectsCode(bridge.request('echo', cycle), 'INVALID_REQUEST');
  await rejectsCode(bridge.request('echo', 1n), 'INVALID_REQUEST');
  assert.equal(service.resolves.length, 0);
});

test('request cancellation terminates the worker, rejects peers, and never replays them', async (t) => {
  const { bridge, service } = bridgeFor(t);
  await bridge.request('echo');
  const controller = new AbortController();
  const first = rejectsCode(bridge.request('hang', {}, controller.signal), 'ABORT_ERR');
  const second = rejectsCode(bridge.request('hang'), 'WORKER_INTERRUPTED');
  await flush();
  controller.abort(new Error(PRIVATE));
  await Promise.all([first, second]);
  assert.deepEqual(await bridge.request('echo', { fresh: true }), { fresh: true });
  assert.equal(service.spawns.length, 2);
  assert.equal(service.handles[0].terminated, 1);
  assert.equal(service.handles[0].alive, false);
  assert.equal(service.handles[0].waited, 1);
});

test('timeout also terminates pending work and allows an explicit later restart', async (t) => {
  // Real TS worker startup competes with parallel native tests. This checks a
  // hung request and confirmed restart, not a sub-250ms cold-launch benchmark.
  const { bridge, service } = bridgeFor(t, realService(), { requestTimeoutMs: 1000 });
  await bridge.request('echo');
  const first = rejectsCode(bridge.request('hang'), 'REQUEST_TIMEOUT');
  const second = rejectsCode(bridge.request('hang'), 'WORKER_INTERRUPTED');
  await Promise.all([first, second]);
  assert.equal(await bridge.request('echo', 'fresh'), 'fresh');
  assert.equal(service.spawns.length, 2);
  assert.equal(service.handles[0].alive, false);
  assert.equal(service.handles[0].terminated, 1);
});

test('startup readiness is covered by the same request timeout', async (t) => {
  const { bridge, service } = bridgeFor(t, realService(), {
    dataPath: 'no-ready',
    requestTimeoutMs: 100,
  });
  await rejectsCode(bridge.request('echo'), 'REQUEST_TIMEOUT');
  await bridge.close();
  assert.equal(service.handles[0].alive, false);
  assert.equal(service.handles[0].terminated, 1);
});

test('abort during executable resolution prevents spawn and passes a cancellation signal', async (t) => {
  const resolution = gate<string>();
  const service = mockService({ resolve: () => resolution.promise });
  const { bridge } = bridgeFor(t, service);
  const controller = new AbortController();
  const rejected = rejectsCode(bridge.request('echo', {}, controller.signal), 'ABORT_ERR');
  await flush();
  controller.abort();
  assert.equal(service.resolves[0][2]?.aborted, true);
  resolution.resolve(NODE);
  await rejected;
  await bridge.close();
  assert.equal(service.spawns.length, 0);
});

test('resolve and spawn failures are sanitized and a later request may retry explicitly', async (t) => {
  let attempt = 0;
  const handle = mockHandle();
  const service = mockService({
    resolve: () => {
      if (++attempt === 1) throw new Error(PRIVATE);
      return NODE;
    },
    spawn: () => {
      if (attempt === 2) throw new Error(PRIVATE);
      return handle;
    },
  });
  const { bridge } = bridgeFor(t, service);
  await rejectsCode(bridge.request('echo'), 'WORKER_START_FAILED');
  await rejectsCode(bridge.request('echo'), 'WORKER_START_FAILED');
  const request = bridge.request('echo');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  handle.stdout.write(line({ id: 3, ok: true, value: 'retry' }));
  assert.equal(await request, 'retry');
  assert.equal(service.resolves.length, 3);
  assert.ok(!JSON.stringify(bridge.status()).includes(PRIVATE));
});

for (const method of ['exit', 'eof', 'partial-eof', 'malformed']) {
  test(`unexpected ${method} rejects every pending request and does not replay`, async (t) => {
    const { bridge, service } = bridgeFor(t);
    const expected =
      method === 'malformed' ? ['WORKER_PROTOCOL_ERROR'] : ['WORKER_EXITED', 'WORKER_EOF'];
    const check = (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && typeof error.code === 'string');
      assert.ok(expected.includes(error.code));
      assert.ok(!String(error).includes(PRIVATE));
      return true;
    };
    const hanging = assert.rejects(bridge.request('hang'), check);
    const trigger = assert.rejects(bridge.request(method), check);
    await Promise.all([hanging, trigger]);
    assert.equal(await bridge.request('echo', 'restarted'), 'restarted');
    assert.equal(service.spawns.length, 2);
    assert.equal(service.handles[0].alive, false);
  });
}

for (const dataPath of ['bad-ready', 'exit-before-ready']) {
  test(`startup failure ${dataPath} rejects and quiesces`, async (t) => {
    const { bridge } = bridgeFor(t, realService(), { dataPath });
    await assert.rejects(bridge.request('echo'), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && typeof error.code === 'string');
      assert.ok(['WORKER_PROTOCOL_ERROR', 'WORKER_EOF', 'WORKER_EXITED'].includes(error.code));
      return true;
    });
    await bridge.close();
  });
}

test('close before the lazy start microtask never resolves or spawns', async (t) => {
  const { bridge, service } = bridgeFor(t, mockService());
  const rejected = rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  await bridge.close();
  await rejected;
  assert.equal(service.resolves.length, 0);
  assert.equal(service.spawns.length, 0);
});

test('close during resolution waits for startup settlement without starting a process', async (t) => {
  const resolution = gate<string>();
  const { bridge, service } = bridgeFor(t, mockService({ resolve: () => resolution.promise }));
  const rejected = rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  await flush();
  let closed = false;
  const closing = bridge.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);
  assert.equal(service.resolves[0][2]?.aborted, true);
  resolution.resolve(NODE);
  await Promise.all([closing, rejected]);
  assert.equal(service.spawns.length, 0);
});

test('close interrupts a signal-aware executable resolver without waiting for ready', async (t) => {
  const service = mockService({
    resolve: (_command, _env, signal) =>
      new Promise((_resolve, reject) => {
        assert.ok(signal);
        signal.addEventListener('abort', () => reject(new Error(PRIVATE)), { once: true });
      }),
  });
  const { bridge } = bridgeFor(t, service);
  const rejected = rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  await flush();
  await bridge.close();
  await rejected;
  assert.equal(service.spawns.length, 0);
});

test('close during asynchronous spawn captures and closes the late handle', async (t) => {
  const startup = gate<InstrumentedHandle>();
  const handle = mockHandle();
  const { bridge, service } = bridgeFor(t, mockService({ spawn: () => startup.promise }));
  const rejected = rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  await flush();
  let closed = false;
  const closing = bridge.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);
  startup.resolve(handle);
  await Promise.all([closing, rejected]);
  assert.equal(service.spawns.length, 1);
  assert.equal(handle.stdin.writableEnded, true);
  assert.equal(handle.alive, false);
  assert.equal(handle.waited, 1);
});

test('abort during asynchronous spawn terminates the late child before a replacement starts', async (t) => {
  const startup = gate<InstrumentedHandle>();
  const old = mockHandle({ autoTerminate: false });
  const replacement = mockHandle();
  let count = 0;
  const { bridge, service } = bridgeFor(
    t,
    mockService({ spawn: () => (++count === 1 ? startup.promise : replacement) }),
  );
  const controller = new AbortController();
  const rejected = rejectsCode(bridge.request('hang', {}, controller.signal), 'ABORT_ERR');
  await flush();
  controller.abort();
  await rejected;
  const next = bridge.request('echo');
  startup.resolve(old);
  await flush();
  assert.equal(old.terminated, 1);
  assert.equal(service.spawns.length, 1, 'replacement waits until old child is quiescent');
  old.exit();
  await flush();
  assert.equal(service.spawns.length, 2);
  replacement.stdout.write(line(ready));
  await flush();
  replacement.stdout.write(line({ id: 2, ok: true, value: 'new' }));
  assert.equal(await next, 'new');
});

test('cancelling a request queued behind shutdown cannot start a replacement', async (t) => {
  const old = mockHandle({ autoTerminate: false });
  const { bridge, service } = bridgeFor(t, mockService({ spawn: () => old }));
  const firstAbort = new AbortController();
  const first = rejectsCode(bridge.request('hang', {}, firstAbort.signal), 'ABORT_ERR');
  await flush();
  old.stdout.write(line(ready));
  await flush();
  firstAbort.abort();
  await first;
  const queuedAbort = new AbortController();
  const queued = rejectsCode(bridge.request('echo', {}, queuedAbort.signal), 'ABORT_ERR');
  queuedAbort.abort();
  await queued;
  old.exit();
  await flush();
  assert.equal(service.spawns.length, 1);
  assert.equal(bridge.status().state, 'idle');
});

test('direct exit still terminates its managed range and fences an explicit replacement', async (t) => {
  const old = splitRangeHandle();
  const replacement = mockHandle();
  let starts = 0;
  // Register release before bridgeFor's after-hook, including on a red assertion.
  t.after(() => {
    old.exitDirect();
    old.exitRange();
  });
  const { bridge, service } = bridgeFor(
    t,
    mockService({ spawn: () => (++starts === 1 ? old : replacement) }),
  );
  const rejected = rejectsCode(bridge.request('hang'), 'WORKER_EXITED');
  await flush();
  old.stdout.write(line(ready));
  await flush();
  old.exitDirect();
  await rejected;
  await flush();
  assert.equal(old.terminated, 1, 'direct completion must not skip managed-range termination');
  assert.equal(old.alive, true, 'the descendant range is still alive after its root exits');
  const next = bridge.request('echo');
  await flush();
  assert.equal(service.spawns.length, 1, 'a signal alone does not permit a replacement');
  old.exitRange();
  await flush();
  assert.equal(service.spawns.length, 2);
  replacement.stdout.write(line(ready));
  await flush();
  replacement.stdout.write(line({ id: 2, ok: true, value: 'fresh after range exit' }));
  assert.equal(await next, 'fresh after range exit');
  assert.equal(old.waited, 1);
});

test('graceful direct exit terminates surviving descendants and close waits for the range', async (t) => {
  const handle = splitRangeHandle();
  t.after(() => {
    handle.exitDirect();
    handle.exitRange();
  });
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const rejected = rejectsCode(bridge.request('hang'), 'BRIDGE_CLOSED');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  handle.stdin.once('finish', () => handle.exitDirect());
  let closed = false;
  const closing = bridge.close().then(() => {
    closed = true;
  });
  await rejected;
  // Healthy ranges get the existing EOF grace; a surviving range must then be
  // terminated even though the direct command has already reported success.
  const controller = new AbortController();
  const deadline = delay(2_000, false, { signal: controller.signal });
  try {
    assert.equal(await Promise.race([handle.termination.then(() => true), deadline]), true);
  } finally {
    controller.abort();
  }
  await flush();
  assert.equal(handle.stdin.writableEnded, true);
  assert.equal(handle.terminated, 1, 'graceful root completion is not range quiescence');
  assert.equal(closed, false);
  assert.equal(handle.alive, true);
  handle.exitRange();
  await closing;
  assert.equal(handle.waited, 1);
  assert.equal(bridge.status().state, 'closed');
});

test('direct-exit range observation failure is sanitized and forbids replacement', async (t) => {
  const handle = splitRangeHandle();
  t.after(() => {
    handle.exitDirect();
    handle.exitRange();
  });
  const service = mockService({ spawn: () => handle });
  const bridge = new WorkerBridge({
    subprocess: service,
    nodePath: NODE,
    workerPath: WORKER,
    cwd: CWD,
    dataPath: 'normal',
  });
  const rejected = rejectsCode(bridge.request('hang'), 'WORKER_EXITED');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  handle.exitDirect();
  await rejected;
  await flush();
  assert.equal(handle.terminated, 1);
  handle.failObservation();
  await rejectsCode(bridge.request('echo'), 'WORKER_SHUTDOWN_FAILED');
  await rejectsCode(bridge.close(), 'WORKER_SHUTDOWN_FAILED');
  await rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  assert.equal(service.spawns.length, 1);
  assert.equal(bridge.status().lastErrorCode, 'WORKER_SHUTDOWN_FAILED');
});

test('close while waiting for ready drains startup and exits normally', async (t) => {
  const { bridge, service } = bridgeFor(t, realService(), { dataPath: 'slow-ready' });
  const rejected = rejectsCode(bridge.request('echo'), 'BRIDGE_CLOSED');
  await flush();
  await bridge.close();
  await rejected;
  assert.equal(service.handles[0].alive, false);
  assert.equal(service.handles[0].terminated, 0);
});

test('close escalates a stubborn child after a finite grace period and waits for exit', async (t) => {
  const { bridge, service } = bridgeFor(t, realService(), { dataPath: 'ignore-close' });
  await bridge.request('echo');
  const started = Date.now();
  const first = bridge.close();
  assert.equal(first, bridge.close());
  await first;
  assert.ok(Date.now() - started >= 900);
  assert.equal(service.handles[0].terminated, 1);
  assert.equal(service.handles[0].waited, 1);
  assert.equal(service.handles[0].alive, false);
});

test('stdin failure is sanitized and terminates the affected worker', async (t) => {
  const handle = mockHandle();
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const rejected = rejectsCode(bridge.request('hang'), 'WORKER_IO_FAILED');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  handle.stdin.emit('error', new Error(PRIVATE));
  await rejected;
  await bridge.close();
  assert.equal(handle.terminated, 1);
});

test('serialization hooks cannot enqueue after close or create duplicate IDs', async (t) => {
  const closed = bridgeFor(t, mockService());
  await rejectsCode(
    closed.bridge.request('echo', {
      toJSON() {
        void closed.bridge.close();
        return {};
      },
    }),
    'BRIDGE_CLOSED',
  );
  assert.equal(closed.bridge.status().pending, 0);
  assert.equal(closed.service.spawns.length, 0);

  const { bridge } = bridgeFor(t);
  let nested: Promise<unknown> | undefined;
  const outer = bridge.request('echo', {
    toJSON() {
      nested = bridge.request('echo', 'inner');
      return 'outer';
    },
  });
  assert.deepEqual(await Promise.all([outer, nested]), ['outer', 'inner']);
});

test('a rejected done promise still triggers termination and a quiescence check', async (t) => {
  const handle = mockHandle();
  const completion = gate<Exit>();
  const realExit = handle.done;
  handle.done = completion.promise;
  handle.waitForExit = async function () {
    this.waited++;
    await realExit;
    return !this.alive;
  };
  const { bridge } = bridgeFor(t, mockService({ spawn: () => handle }));
  const rejected = rejectsCode(bridge.request('hang'), 'WORKER_EXITED');
  await flush();
  handle.stdout.write(line(ready));
  await flush();
  completion.reject(new Error(PRIVATE));
  await rejected;
  await bridge.close();
  assert.equal(handle.terminated, 1);
  assert.equal(handle.waited, 1);
});

test('unconfirmed quiescence fails closed instead of claiming success or spawning again', async () => {
  const handle = mockHandle();
  handle.waitForExit = async function () {
    this.waited++;
    return false;
  };
  const service = mockService({ spawn: () => handle });
  const bridge = new WorkerBridge({
    subprocess: service,
    nodePath: NODE,
    workerPath: WORKER,
    cwd: CWD,
    dataPath: 'normal',
  });
  const rejected = rejectsCode(bridge.request('hang'), 'WORKER_PROTOCOL_ERROR');
  await flush();
  handle.stdout.write('invalid-json\n');
  await rejected;
  await rejectsCode(bridge.request('echo'), 'WORKER_SHUTDOWN_FAILED');
  await rejectsCode(bridge.close(), 'WORKER_SHUTDOWN_FAILED');
  assert.equal(bridge.status().state, 'closing');
  assert.equal(bridge.status().lastErrorCode, 'WORKER_SHUTDOWN_FAILED');
  assert.equal(service.spawns.length, 1);
  assert.equal(handle.alive, false);
});

test('an already-completed request detaches cancellation and cannot kill a later request', async (t) => {
  const { bridge, service } = bridgeFor(t);
  const controller = new AbortController();
  await bridge.request('echo', {}, controller.signal);
  const request = bridge.request('delay', { ms: 30, value: 'still alive' });
  controller.abort();
  assert.equal(await request, 'still alive');
  await delay(5);
  assert.equal(service.spawns.length, 1);
  assert.equal(service.handles[0].terminated, 0);
});
