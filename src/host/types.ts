import type { SearchMode, SessionRow, ReadRequest } from '../shared/model.js';
import type { SyncReport } from './sync.js';

export interface PluginConfig {
  nodePath: string;
  dataPath: string;
  sessionIds: string[];
  embeddingSessionIds: string[];
  envFile?: string;
  callerSessionIds: string[];
  autoSync: boolean;
  dominantMin: number;
  dominantGap: number;
}
export interface ScopeArgs {
  scope?: string;
}
export interface SearchArgs extends ScopeArgs {
  query: string;
  mode: SearchMode;
  role?: 'user' | 'assistant';
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
}
export interface SessionsArgs extends ScopeArgs {
  query?: string;
  offset?: number;
  limit?: number;
}
export interface ReadArgs extends Partial<ReadRequest> {
  cursor?: string;
}
export interface StatusArgs extends ScopeArgs {
  action?: 'status' | 'sync' | 'embed';
}
export interface SyncFailure {
  sessionId: string;
  error: string;
  skipped?: never;
}
export interface SyncSummary {
  results: (SyncReport | SyncFailure)[];
  deferred: number;
}
export interface PendingSession {
  sessionId: string;
  title: string;
  indexed: false;
  pending: true;
}
export interface SessionPageSnapshot {
  rows: (SessionRow | PendingSession)[];
  expires: number;
  truncated: boolean;
  unindexedCount: number;
  titleFilterIncomplete: boolean;
}
export interface CursorBase {
  caller: string;
  expires: number;
  instance?: string;
}
export interface SearchCursor extends CursorBase {
  kind: 'search';
  scopeId: string;
  queryBinding: string;
  inner: string;
}
export interface ReadCursor extends CursorBase, ReadRequest {
  kind?: never;
}
export type HostCursor = SearchCursor | ReadCursor;
