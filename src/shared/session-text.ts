import type { SessionEvent, SessionSnapshot, SourceMessage } from '../host/contracts.js';
import type { MessageRow, BlockRow, VisibleBlock } from './model.js';

/** The pure extractor also accepts the historical fixture origin representation.
 * Live DSH headers use the narrower string representation in host/contracts.ts.
 */
export interface ExtractionSnapshot extends Omit<SessionSnapshot, 'session'> {
  session: Omit<SessionSnapshot['session'], 'origin'> & { origin?: string | { kind: string } };
}
export interface ExtractOptions {
  title?: string;
  maxSeq?: number;
  eventOffset?: number;
}
export interface ExtractionStats {
  totalEvents: number;
  capturedThroughSeq: number;
  eligibleMessages: number;
  textBlocks: number;
  excludedByReason: { source: number; replacement: number; type: number; empty: number };
  sourceKind: Record<string, number>;
}
export interface ExtractedSession {
  sessionId: string;
  messages: MessageRow[];
  blocks: BlockRow[];
  stats: ExtractionStats;
}
// Pure projection of the durable event log, never the current (possibly compacted) surface.
const sourceKinds = new Set(['user', 'model', 'tool', 'system', 'plugin', 'subagent', 'scheduler']);

export function messageOf(event: SessionEvent): SourceMessage | undefined {
  // The public event discriminator defines these envelopes; no private replay fields are used.
  if (event.type === 'user/message') return event.data as SourceMessage;
  if (event.type === 'assistant/message')
    return (event.data as { message?: SourceMessage } | undefined)?.message;
  return undefined;
}

/**
 * Extract a fixed event prefix without changing the snapshot or its text.
 * Stats count only events at/below maxSeq; each excluded event has one reason.
 * sourceKind counts message-event sources (including excluded messages), never text.
 * Inheritance is a prefix length in events, not a sequence-number threshold.
 */
export function extractSession(
  snapshot: ExtractionSnapshot,
  { title, maxSeq, eventOffset = 0 }: ExtractOptions = {},
): ExtractedSession {
  if (maxSeq !== undefined && (!Number.isSafeInteger(maxSeq) || maxSeq < 0)) {
    throw new TypeError('maxSeq must be a non-negative safe integer');
  }
  const { session, events, inheritedEventCount } = snapshot;
  const sessionId = session.id;
  const origin =
    typeof session.origin === 'string'
      ? session.origin
      : typeof session.origin?.kind === 'string'
        ? session.origin.kind
        : 'main';
  const messages: MessageRow[] = [],
    blocks: BlockRow[] = [];
  const stats: ExtractionStats = {
    totalEvents: 0,
    capturedThroughSeq: 0,
    eligibleMessages: 0,
    textBlocks: 0,
    excludedByReason: { source: 0, replacement: 0, type: 0, empty: 0 },
    sourceKind: {},
  };

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (maxSeq !== undefined && event.seq > maxSeq) continue;
    stats.totalEvents++;
    stats.capturedThroughSeq = Math.max(stats.capturedThroughSeq, event.seq);
    const message = messageOf(event);
    if (!message) {
      stats.excludedByReason.type++;
      continue;
    }
    const source = message.source;
    const sourceKind = source && sourceKinds.has(source.kind) ? source.kind : 'unknown';
    stats.sourceKind[sourceKind] = (stats.sourceKind[sourceKind] ?? 0) + 1;
    // Objects are replacement operations; their summaries are not original speech.
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
      stats.excludedByReason.replacement++;
      continue;
    }
    if (
      (event.type === 'user/message' && message.role !== 'user') ||
      (event.type === 'assistant/message' && message.role !== 'assistant')
    ) {
      stats.excludedByReason.type++;
      continue;
    }
    if (
      !(message.role === 'user' && source?.kind === 'user' && source.form !== 'relay') &&
      !(message.role === 'assistant' && source?.kind === 'model')
    ) {
      stats.excludedByReason.source++;
      continue;
    }

    const content: VisibleBlock[] = [];
    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      if (!block || !['text', 'image', 'file'].includes(block.type)) continue;
      if (block.type === 'text' && (typeof block.text !== 'string' || !/\S/u.test(block.text)))
        continue;
      // Keep attachment references and visible fields, but never replay/source internals.
      content.push({
        ...block,
        type: block.type as VisibleBlock['type'],
        source: undefined,
        replayState: undefined,
        blockIndex,
        sourceKind: source.kind,
        provider: typeof source.provider === 'string' ? source.provider : undefined,
        model: typeof source.model === 'string' ? source.model : undefined,
        originalMessageId: typeof message.id === 'string' ? message.id : undefined,
        inherited: eventOffset + eventIndex < inheritedEventCount,
      });
    }
    if (!content.length) {
      stats.excludedByReason.empty++;
      continue;
    }

    const id = `${sessionId}:${event.seq}`;
    messages.push({
      id,
      sessionId,
      title: title ?? session.title ?? '',
      cwd: session.cwd ?? '',
      origin,
      archived: false,
      eventSeq: event.seq,
      time: event.time,
      role: message.role,
      contentJson: JSON.stringify(content),
    });
    for (const block of content) {
      if (block.type !== 'text') continue;
      blocks.push({
        id: `${id}:${block.blockIndex}`,
        messageId: id,
        sessionId,
        origin,
        role: message.role,
        time: event.time,
        eventSeq: event.seq,
        blockIndex: block.blockIndex,
        text: block.text!,
      });
    }
  }
  stats.eligibleMessages = messages.length;
  stats.textBlocks = blocks.length;
  return { sessionId, messages, blocks, stats };
}
