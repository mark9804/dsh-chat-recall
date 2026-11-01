import { StringDecoder } from 'node:string_decoder';
import type { SubprocessHandle, SubprocessService } from './contracts.js';
import { errorCode } from '../shared/model.js';

export interface BridgeOptions {
  subprocess: SubprocessService;
  nodePath: string;
  workerPath: string;
  cwd: string;
  envFile?: string;
  dataPath: string;
  requestTimeoutMs?: number;
}
export interface WorkerReady {
  type: 'ready';
  protocol: 1;
  pid: number;
  node: string;
  lancedb: string;
}
export interface BridgeStatus {
  state: 'idle' | 'starting' | 'ready' | 'stopping' | 'closing' | 'closed';
  ready: WorkerReady | null;
  pending: number;
  lastErrorCode: string | null;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
interface PendingRequest {
  id: number;
  payload: string;
  result: Deferred<unknown>;
  signal?: AbortSignal;
  run: WorkerRun | null;
  timer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
}
interface WorkerRun {
  ready: Deferred<void>;
  finished: Deferred<void>;
  requests: Set<PendingRequest>;
  controller: AbortController;
  handle: SubprocessHandle | null;
  handshake: WorkerReady | null;
  stopping: boolean;
  exited: boolean;
  decoder: StringDecoder;
  buffer: string;
  shutdownError: boolean;
  startTask?: Promise<void>;
  done?: Promise<void>;
}

const CLOSE_GRACE_MS = 1_000;
const MAX_LINE_LENGTH = 16 * 1024 * 1024;
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WORKER_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'VALIDATION_ERROR',
  'UNKNOWN_METHOD',
  'METHOD_NOT_FOUND',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NOT_CONFIGURED',
  'EMBEDDING_ERROR',
  'EMBEDDING_FAILED',
  'DATABASE_ERROR',
  'LANCEDB_ERROR',
  'WORKER_ERROR',
  'INTERNAL_ERROR',
  'WORKER_REQUEST_FAILED',
  'NOT_PREPARED',
  'EMBEDDING_NOT_READY',
  'EMBEDDING_CONFIG_CHANGED',
  'NO_EMBEDDING_CONFIG',
  'HTTP_ERROR',
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
  'ABORTED',
  'TIMEOUT',
  'SOURCE_CHANGED',
  'SYNC_INCOMPLETE',
  'CURSOR_EXPIRED',
  'INVALID_CURSOR',
  'SEARCH_CAPACITY',
]);
const MESSAGES: Record<string, string> = {
  BRIDGE_CLOSED: 'Worker bridge is closed.',
  INVALID_REQUEST: 'Invalid worker request.',
  ABORT_ERR: 'Worker request was cancelled; backend completion is unknown.',
  REQUEST_TIMEOUT: 'Worker request timed out; backend completion is unknown.',
  WORKER_INTERRUPTED: 'Worker was interrupted; backend completion is unknown.',
  WORKER_START_FAILED: 'Worker could not be started.',
  WORKER_EXITED: 'Worker exited unexpectedly; backend completion is unknown.',
  WORKER_EOF: 'Worker output ended unexpectedly; backend completion is unknown.',
  WORKER_IO_FAILED: 'Worker communication failed; backend completion is unknown.',
  WORKER_PROTOCOL_ERROR: 'Worker sent an invalid protocol message.',
  WORKER_SHUTDOWN_FAILED: 'Worker shutdown could not be confirmed.',
};

function failure(code: string): Error & { code: string } {
  const error = Object.assign(new Error(MESSAGES[code] ?? 'Worker request failed.'), { code });
  if (code === 'ABORT_ERR') error.name = 'AbortError';
  return error;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A single, lazy, newline-JSON worker. No native modules are loaded in the host. */
export class WorkerBridge {
  #options: Required<Omit<BridgeOptions, 'envFile'>> & Pick<BridgeOptions, 'envFile'>;
  #run: WorkerRun | null = null;
  #requests = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #closeFinished = false;
  #lastErrorCode: string | null = null;

  constructor({
    subprocess,
    nodePath,
    workerPath,
    cwd,
    envFile,
    dataPath,
    requestTimeoutMs = 60_000,
  }: BridgeOptions) {
    if (
      !subprocess ||
      typeof subprocess.resolveExecutable !== 'function' ||
      typeof subprocess.spawn !== 'function' ||
      [nodePath, workerPath, cwd, dataPath].some(
        (value) => typeof value !== 'string' || !value || value.includes('\0'),
      ) ||
      (envFile !== undefined &&
        (typeof envFile !== 'string' || !envFile || envFile.includes('\0'))) ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 2_147_483_647
    ) {
      throw failure('INVALID_REQUEST');
    }
    this.#options = { subprocess, nodePath, workerPath, cwd, envFile, dataPath, requestTimeoutMs };
  }

  /** Local-only snapshot: never resolves an executable, starts a child, or probes a backend. */
  status(): BridgeStatus {
    const run = this.#run;
    return {
      state: this.#closed
        ? this.#closeFinished
          ? 'closed'
          : 'closing'
        : !run
          ? 'idle'
          : run.stopping
            ? 'stopping'
            : run.handshake
              ? 'ready'
              : 'starting',
      ready: run?.handshake ? { ...run.handshake } : null,
      pending: this.#requests.size,
      lastErrorCode: this.#lastErrorCode,
    };
  }

  request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(failure('BRIDGE_CLOSED'));
    if (signal?.aborted) return Promise.reject(failure('ABORT_ERR'));
    let payload;
    const id = this.#nextId;
    try {
      if (
        typeof method !== 'string' ||
        !method ||
        !Number.isSafeInteger(id) ||
        (signal &&
          (typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function'))
      ) {
        throw failure('INVALID_REQUEST');
      }
      this.#nextId++;
      payload = `${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(failure('INVALID_REQUEST'));
    }
    // Serializing caller-owned params can run a toJSON hook, including close/abort.
    if (this.#closed) return Promise.reject(failure('BRIDGE_CLOSED'));
    if (signal?.aborted) return Promise.reject(failure('ABORT_ERR'));
    const result = deferred<unknown>();
    const request: PendingRequest = {
      id,
      payload,
      result,
      signal,
      run: null,
      timer: null,
      onAbort: null,
    };
    this.#requests.set(id, request);
    request.onAbort = () => this.#cancel(request, 'ABORT_ERR');
    signal?.addEventListener('abort', request.onAbort, { once: true });
    request.timer = setTimeout(
      () => this.#cancel(request, 'REQUEST_TIMEOUT'),
      this.#options.requestTimeoutMs,
    );
    // Recheck after listener registration. An already-cancelled request must not spawn.
    if (signal?.aborted) request.onAbort();
    void this.#dispatch(request);
    return result.promise;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const error = failure('BRIDGE_CLOSED');
    for (const request of this.#requests.values()) this.#settle(request, error);
    const run = this.#run;
    this.#closePromise = (run ? this.#stop(run, error, true) : Promise.resolve()).then(() => {
      if (run?.shutdownError) throw failure('WORKER_SHUTDOWN_FAILED');
      this.#closeFinished = true;
    });
    return this.#closePromise;
  }

  #settle(request: PendingRequest, error?: Error | null, value?: unknown): void {
    if (!this.#requests.delete(request.id)) return;
    if (request.timer) clearTimeout(request.timer);
    if (request.onAbort) request.signal?.removeEventListener('abort', request.onAbort);
    request.run?.requests.delete(request);
    if (error) request.result.reject(error);
    else request.result.resolve(value);
  }

  #cancel(request: PendingRequest, code: string): void {
    if (!this.#requests.has(request.id)) return;
    this.#lastErrorCode = code;
    this.#settle(request!, failure(code));
    if (request.run) this.#stop(request.run, failure('WORKER_INTERRUPTED'));
  }

  async #dispatch(request: PendingRequest): Promise<void> {
    try {
      while (this.#requests.has(request.id) && !this.#closed) {
        let run = this.#run;
        if (run?.stopping) {
          await run.finished.promise;
          if (run.shutdownError) throw failure('WORKER_SHUTDOWN_FAILED');
          continue;
        }
        if (!run) {
          run = {
            ready: deferred<void>(),
            finished: deferred<void>(),
            requests: new Set<PendingRequest>(),
            controller: new AbortController(),
            handle: null,
            handshake: null,
            stopping: false,
            exited: false,
            decoder: new StringDecoder('utf8'),
            buffer: '',
            shutdownError: false,
          };
          // The ready gate can fail before an awaiting dispatch gets to it.
          void run.ready.promise.catch(() => {});
          this.#run = run;
          const current = run;
          run.startTask = Promise.resolve().then(() => this.#start(current));
        }
        request.run = run;
        run.requests.add(request);
        await run.ready.promise;
        if (!this.#requests.has(request.id) || run.stopping || this.#closed) return;
        run.handle!.stdin.write(request.payload, (error) => {
          if (error) this.#stop(run, failure('WORKER_IO_FAILED'));
        });
        return;
      }
    } catch (error) {
      if (request.run && !request.run.stopping)
        this.#stop(request.run, failure('WORKER_IO_FAILED'));
      this.#settle(
        request,
        failure(
          Object.hasOwn(MESSAGES, errorCode(error, '')) ? errorCode(error, '') : 'WORKER_IO_FAILED',
        ),
      );
    }
  }

  async #start(run: WorkerRun): Promise<void> {
    try {
      const { subprocess, nodePath, workerPath, cwd, envFile, dataPath } = this.#options;
      if (run.stopping || this.#closed) return;
      const executable = await subprocess.resolveExecutable(
        nodePath,
        undefined,
        run.controller.signal,
      );
      if (run.stopping || this.#closed) return;
      const argv = [
        executable,
        ...(envFile === undefined ? [] : [`--env-file=${envFile}`]),
        workerPath,
        dataPath,
      ];
      // spawn may itself be asynchronous. Shutdown waits for a late handle, too.
      const handle = await subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: CLOSE_GRACE_MS,
      });
      run.handle = handle;
      run.done = Promise.resolve(handle.done).then(
        () => {
          run.exited = true;
          if (!run.stopping) this.#stop(run, failure('WORKER_EXITED'));
        },
        () => {
          // A rejected completion promise is not evidence that the process exited.
          if (!run.stopping) this.#stop(run, failure('WORKER_EXITED'));
        },
      );
      handle.stdin.on('error', () => this.#stop(run, failure('WORKER_IO_FAILED')));
      handle.stdout.on('data', (chunk) => this.#read(run, chunk));
      handle.stdout.on('end', () => this.#stop(run, failure('WORKER_EOF')));
      handle.stdout.on('close', () => this.#stop(run, failure('WORKER_EOF')));
      handle.stdout.on('error', () => this.#stop(run, failure('WORKER_IO_FAILED')));
      // Do not retain or forward stderr: it may contain credentials or env-file diagnostics.
      handle.stderr.on('error', () => {});
      handle.stderr.resume();
    } catch {
      this.#stop(run, failure('WORKER_START_FAILED'));
    }
  }

  #read(run: WorkerRun, chunk: string | Buffer): void {
    if (run.stopping) return;
    run.buffer += typeof chunk === 'string' ? chunk : run.decoder.write(chunk);
    let newline;
    while ((newline = run.buffer.indexOf('\n')) !== -1) {
      if (newline > MAX_LINE_LENGTH) return void this.#stop(run, failure('WORKER_PROTOCOL_ERROR'));
      const line = run.buffer.slice(0, newline);
      run.buffer = run.buffer.slice(newline + 1);
      try {
        this.#message(run, JSON.parse(line));
      } catch {
        this.#stop(run, failure('WORKER_PROTOCOL_ERROR'));
      }
      if (run.stopping) return;
    }
    if (run.buffer.length > MAX_LINE_LENGTH) this.#stop(run, failure('WORKER_PROTOCOL_ERROR'));
  }

  #message(run: WorkerRun, payload: unknown): void {
    const message = payload as Record<string, unknown>;
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw failure('WORKER_PROTOCOL_ERROR');
    if (!run.handshake) {
      if (
        message.type !== 'ready' ||
        message.protocol !== 1 ||
        !Number.isSafeInteger(message.pid) ||
        typeof message.pid !== 'number' ||
        message.pid < 1 ||
        typeof message.node !== 'string' ||
        message.node.length > 128 ||
        !VERSION.test(message.node) ||
        typeof message.lancedb !== 'string' ||
        message.lancedb.length > 128 ||
        !VERSION.test(message.lancedb)
      ) {
        throw failure('WORKER_PROTOCOL_ERROR');
      }
      run.handshake = {
        type: 'ready',
        protocol: 1,
        pid: message.pid,
        node: message.node,
        lancedb: message.lancedb,
      };
      run.ready.resolve();
      return;
    }
    const request = this.#requests.get(message.id as number);
    const workerError = message.error as { code?: unknown; message?: unknown } | undefined;
    if (
      !Number.isSafeInteger(message.id) ||
      !request ||
      request.run !== run ||
      typeof message.ok !== 'boolean' ||
      (message.ok && !Object.hasOwn(message, 'value')) ||
      (!message.ok &&
        (!message.error ||
          typeof workerError!.code !== 'string' ||
          typeof workerError!.message !== 'string'))
    ) {
      throw failure('WORKER_PROTOCOL_ERROR');
    }
    if (message.ok) this.#settle(request!, null, message.value);
    else {
      // An arbitrary uppercase string could still be a secret: retain only known codes.
      const code = WORKER_ERROR_CODES.has(workerError!.code as string)
        ? (workerError!.code as string)
        : 'WORKER_REQUEST_FAILED';
      this.#lastErrorCode = code;
      this.#settle(request, failure(code));
    }
  }

  #stop(run: WorkerRun, error: Error & { code: string }, graceful = false): Promise<void> {
    if (run.stopping) return run.finished.promise;
    run.stopping = true;
    if (!['BRIDGE_CLOSED', 'WORKER_INTERRUPTED'].includes(error.code))
      this.#lastErrorCode = error.code;
    run.controller.abort();
    run.ready.reject(error);
    for (const request of run.requests) this.#settle(request, error);
    run.buffer = '';
    void (async () => {
      await run.startTask;
      const handle = run.handle;
      if (handle) {
        if (graceful && !run.exited) {
          let timer: NodeJS.Timeout | undefined;
          try {
            handle.stdin.end();
            await Promise.race([
              run.done,
              new Promise((resolve) => {
                timer = setTimeout(resolve, CLOSE_GRACE_MS);
              }),
            ]);
          } catch {
            // A broken stdin still needs termination and a quiescence wait.
          } finally {
            clearTimeout(timer);
          }
        }
        if (!run.exited) handle.terminate();
        await run.done;
        if (!(await handle.waitForExit())) throw failure('WORKER_SHUTDOWN_FAILED');
      }
    })().then(
      () => {
        if (this.#run === run) this.#run = null;
        run.finished.resolve();
      },
      () => {
        // Do not start a replacement if the subprocess service cannot confirm quiescence.
        run.shutdownError = true;
        this.#lastErrorCode = 'WORKER_SHUTDOWN_FAILED';
        run.finished.resolve();
      },
    );
    return run.finished.promise;
  }
}
