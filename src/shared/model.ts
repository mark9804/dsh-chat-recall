/** Durable index rows. These interfaces describe our cache, not DSH internals. */
export type Role = 'user' | 'assistant';
export type SearchMode = 'exact' | 'fuzzy' | 'semantic';

export interface SessionRow {
  sessionId: string;
  title: string;
  cwd: string;
  origin: string;
  createdAt: number;
  inheritedEventCount: number;
  cursor: number;
  anchorHash: string;
  updatedAt: number;
}

/** Extra visible attachment fields are preserved, but never interpreted as instructions. */
export interface VisibleBlock {
  type: 'text' | 'image' | 'file';
  blockIndex: number;
  text?: string;
  originalMessageId?: string;
  inherited?: boolean;
  sourceKind?: string;
  provider?: string;
  model?: string;
  truncated?: boolean;
  [key: string]: unknown;
}
export interface MessageRow {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  origin: string;
  archived: boolean;
  eventSeq: number;
  time: number;
  role: string;
  sourceMessageId?: string;
  contentJson: string;
}
export interface BlockRow {
  id: string;
  messageId: string;
  sessionId: string;
  origin: string;
  role: string;
  time: number;
  eventSeq: number;
  blockIndex: number;
  text: string;
}
export interface IndexedBlock extends BlockRow {
  textHash: string;
  dedupKey: string;
}
export interface SyncBatch {
  session: SessionRow;
  messages: MessageRow[];
  blocks: BlockRow[];
}
export interface SearchHit {
  ref: string;
  sessionId: string;
  eventSeq: number;
  blockIndex: number;
  role: string;
  time: number;
  textHash: string;
  excerpt: string;
  start: number;
  end: number;
  similarity?: number;
  score?: number;
  bm25?: number;
  coverage?: number;
  matchedTerms?: string[];
  matchStart?: number;
  matchEnd?: number;
}
export interface Embedder {
  spaceId: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface SearchRequest {
  query: string;
  mode: SearchMode;
  sessionIds: string[];
  role?: string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
  binding: string;
}
export interface ReadRequest {
  ref: string;
  blockIndex?: number;
  offset?: number;
  length?: number;
  before?: number;
  after?: number;
}
export interface ContextMessage {
  ref: string;
  eventSeq: number;
  role: string;
  content: VisibleBlock[];
}
export interface ReadResult {
  ref: string;
  sessionId: string;
  eventSeq: number;
  blockIndex: number;
  role: string;
  time: number;
  text: string | null;
  textHash: string | null;
  offset: number;
  nextOffset: number | null;
  totalLength: number;
  attachments: VisibleBlock[];
  context: ContextMessage[];
}

export function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : fallback;
}
