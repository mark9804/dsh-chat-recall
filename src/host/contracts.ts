import type { Readable, Writable } from 'node:stream';

/** Minimal structural views of public DSH services, checked against rc.5 Inspect.
 * These are not ambient declarations or a replacement Harness SDK. Keeping them
 * type-only prevents Host imports from pulling in the native worker dependencies.
 */
export interface MessageSource {
  kind: string;
  form?: string;
  provider?: string;
  model?: string;
}
export interface SourceBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface SourceMessage {
  id?: string;
  role: string;
  source?: MessageSource;
  content: SourceBlock[];
}
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: unknown;
}
export interface SessionHeader {
  id: string;
  createdAt: number;
  cwd?: string;
  title?: string;
  origin?: string;
  delegationDepth?: number;
}
export interface SessionSnapshot {
  session: SessionHeader;
  inheritedEventCount: number;
  events: readonly SessionEvent[];
}
export interface SessionObservation extends Disposable {
  header: SessionHeader;
  inheritedEventCount: number;
  cursor: number;
  events: readonly SessionEvent[];
}
export interface SessionHandle {
  header: SessionHeader;
  inheritedEventCount: number;
  read(
    offset: number,
    length: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: readonly SessionEvent[] }>;
  close(): Promise<void>;
}
export interface SessionPersistence {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<SessionHandle>;
}
export interface LiveSession {
  id: string;
  header: SessionHeader;
}
export interface SessionQuery {
  listSessions(signal?: AbortSignal): Promise<{ header: SessionHeader }[]>;
  observeSession(
    id: string,
    options: { signal?: AbortSignal; projectionMode: 'none' },
  ): Promise<SessionObservation>;
  readSession(id: string): Promise<SessionSnapshot>;
  readEvent(
    request: { sessionId: string; seq: number; before: number; after: number },
    signal?: AbortSignal,
  ): Promise<{
    session: SessionHeader;
    inheritedEventCount: number;
    target: SessionEvent;
  }>;
}
export interface SubprocessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  done: Promise<unknown>;
  terminate(): void;
  waitForExit(): Promise<boolean>;
}
export interface SubprocessService {
  resolveExecutable(
    command: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string>;
  spawn(spec: {
    argv: string[];
    cwd: string;
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe' };
    graceMs: number;
  }): SubprocessHandle | Promise<SubprocessHandle>;
}
export interface ToolExecution {
  agent?: { id: string };
  signal: AbortSignal;
}
export interface AuthorizedExecution extends ToolExecution {
  agent: { id: string };
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): { type: 'text'; text: string }[];
  };
  timeoutMs: number;
  isConcurrencySafe(args?: unknown): boolean;
  execute(args: unknown, exec: ToolExecution): Promise<unknown>;
}
export interface HostContext {
  tools: { register(definition: ToolDefinition): unknown };
  subprocess: SubprocessService;
  sessionQuery: SessionQuery;
  sessions: { get(id: string): LiveSession | undefined };
  get?(key: 'sessionPersistence'): SessionPersistence | undefined;
  on(
    event: 'session/event',
    listener: (session: LiveSession, event: SessionEvent) => void,
  ): unknown;
  effect(factory: () => () => Promise<void>): unknown;
}
