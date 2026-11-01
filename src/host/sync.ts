import { createHash } from 'node:crypto';
import { extractSession } from '../shared/session-text.js';

import type {
  HostContext,
  SessionEvent,
  SessionHeader,
  SessionHandle,
  SessionObservation,
} from './contracts.js';
import type { WorkerCall } from '../shared/protocol.js';
export interface SyncReport {
  sessionId: string;
  skipped?: 'subagent';
  cursor?: number;
  eventsRead?: number;
  messagesAdded?: number;
  blocksAdded?: number;
  batches?: number;
  source?: 'live-range' | 'persistence-range' | 'query-fallback';
}
export interface SessionSyncOptions {
  ctx: HostContext;
  request: WorkerCall;
  sessionIds?: string[];
}
export const eventHash = (event: SessionEvent) =>
  createHash('sha256').update(JSON.stringify(event)).digest('hex');
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

/** Read public live or persisted ranges; no filesystem log parsing. */
export class SessionSync {
  #ctx: HostContext;
  #request: WorkerCall;
  #allow: string[];
  #pending = new Map<string, Promise<SyncReport>>();
  #stopped = false;
  constructor({ ctx, request, sessionIds = [] }: SessionSyncOptions) {
    this.#ctx = ctx;
    this.#request = request;
    this.#allow = sessionIds;
  }
  allowed(id: string): boolean {
    return this.#allow.includes('all') || this.#allow.includes(id);
  }
  async ids(signal?: AbortSignal): Promise<string[]> {
    if (!this.#allow.includes('all')) return [...new Set(this.#allow)];
    const records = await this.#ctx.sessionQuery.listSessions(signal);
    return records
      .filter((row) => row.header.origin !== 'subagent' && !((row.header.delegationDepth ?? 0) > 0))
      .map((row) => row.header.id);
  }
  sync(id: string, signal?: AbortSignal): Promise<SyncReport> {
    if (!this.allowed(id))
      return Promise.reject(
        Object.assign(new Error('Session outside configured corpus.'), { code: 'OUT_OF_SCOPE' }),
      );
    if (this.#pending.has(id)) return this.#pending.get(id)!.then(() => this.sync(id, signal));
    const promise = this.#sync(id, signal).finally(() => this.#pending.delete(id));
    this.#pending.set(id, promise);
    return promise;
  }
  async #sync(id: string, signal?: AbortSignal): Promise<SyncReport> {
    if (this.#stopped) fail('CLOSED');
    signal?.throwIfAborted();
    const state = await this.#request('checkpoints', { sessionIds: [id] }, signal);
    const checkpoint = state.sessions.find((row) => row.sessionId === id);
    let cursor = checkpoint?.cursor ?? -1;
    const live = this.#ctx.sessions.get(id);
    let handle: SessionHandle | undefined, observation: SessionObservation | undefined;
    let header: SessionHeader, inheritedEventCount: number, lastKnown: number | undefined;
    let readRange: (offset: number, length: number) => Promise<readonly SessionEvent[]>;
    if (live) {
      observation = await this.#ctx.sessionQuery.observeSession(id, {
        signal,
        projectionMode: 'none',
      });
      header = observation.header;
      inheritedEventCount = observation.inheritedEventCount;
      lastKnown = observation.cursor;
      readRange = async (offset, length) =>
        observation!.events.slice(offset, Math.min(lastKnown! + 1, offset + length));
    } else {
      const persistence = this.#ctx.get?.('sessionPersistence');
      if (persistence) {
        handle = await persistence.open(id, 'read', { signal });
        header = handle.header;
        inheritedEventCount = handle.inheritedEventCount;
        readRange = async (offset, length) =>
          (await handle!.read(offset, length, { signal })).events;
      } else {
        const snapshot = await this.#ctx.sessionQuery.readSession(id);
        header = snapshot.session;
        inheritedEventCount = snapshot.inheritedEventCount;
        lastKnown = snapshot.events.length - 1;
        readRange = async (offset, length) => snapshot.events.slice(offset, offset + length);
      }
    }
    try {
      if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
        return { sessionId: id, skipped: 'subagent' };
      if (checkpoint && cursor >= 0) {
        const [anchor] = await readRange(cursor, 1);
        if (!anchor || anchor.seq !== cursor || eventHash(anchor) !== checkpoint.anchorHash)
          fail('SOURCE_CHANGED');
      }
      let title = checkpoint?.title ?? '';
      let eventsRead = 0,
        messagesAdded = 0,
        blocksAdded = 0,
        batches = 0;
      while (!this.#stopped) {
        signal?.throwIfAborted();
        const offset = cursor + 1;
        const events = await readRange(offset, 256);
        if (!events.length) break;
        if (events[0].seq !== offset || events.some((event, index) => event.seq !== offset + index))
          fail('SOURCE_CHANGED');
        for (const event of events) {
          const data = event.data as { title?: unknown } | undefined;
          if (event.type === 'session/title' && typeof data?.title === 'string') title = data.title;
        }
        const data = extractSession(
          { session: header, inheritedEventCount, events },
          { title, eventOffset: offset },
        );
        const last = events.at(-1)!;
        const session = {
          sessionId: id,
          title,
          cwd: header.cwd ?? '',
          origin: header.origin ?? 'main',
          createdAt: header.createdAt,
          inheritedEventCount,
          cursor: last.seq,
          anchorHash: eventHash(last),
          updatedAt: Date.now(),
        };
        await this.#request(
          'sync',
          { session, messages: data.messages, blocks: data.blocks },
          signal,
        );
        cursor = last.seq;
        eventsRead += events.length;
        messagesAdded += data.messages.length;
        blocksAdded += data.blocks.length;
        batches++;
        if (events.length < 256 || (lastKnown !== undefined && cursor >= lastKnown)) break;
      }
      if (this.#stopped) fail('CLOSED');
      if (!batches && (checkpoint || cursor === -1)) {
        const session = {
          sessionId: id,
          title,
          cwd: header.cwd ?? '',
          origin: header.origin ?? 'main',
          createdAt: header.createdAt,
          inheritedEventCount,
          cursor,
          anchorHash: checkpoint?.anchorHash ?? '',
          updatedAt: Date.now(),
        };
        if (!checkpoint || title !== checkpoint.title)
          await this.#request('sync', { session, messages: [], blocks: [] }, signal);
      }
      return {
        sessionId: id,
        cursor,
        eventsRead,
        messagesAdded,
        blocksAdded,
        batches,
        source: live ? 'live-range' : handle ? 'persistence-range' : 'query-fallback',
      };
    } finally {
      observation?.[Symbol.dispose]();
      await handle?.close();
    }
  }
  async close() {
    this.#stopped = true;
    await Promise.allSettled([...this.#pending.values()]);
  }
}
