import type { CandidatePolicy } from '../core/candidates.js';
import type {
  RecallStore,
  CheckpointsRequest,
  EmbedRequest,
  SessionsRequest,
} from '../storage/store.js';
import type { SyncBatch, SearchRequest, ReadRequest } from './model.js';

/** Compile-time JSONL contract; JSON/Arrow boundaries still validate at runtime. */
export interface RequestParams {
  configure: { embeddingEnabled: boolean; candidatePolicy?: CandidatePolicy };
  sync: SyncBatch;
  checkpoints: CheckpointsRequest;
  embed: EmbedRequest;
  search: SearchRequest;
  read: Partial<ReadRequest>;
  sessions: SessionsRequest;
  status: Record<string, never>;
}
export type StoreMethod = Exclude<keyof RecallStore, 'close'>;
export type Method = keyof RequestParams;
export type Params<M extends Method> = RequestParams[M];
export type Result<M extends Method> = M extends 'configure'
  ? { configured: boolean }
  : M extends StoreMethod
    ? Awaited<ReturnType<RecallStore[M]>>
    : never;
export type WorkerRequest = {
  [M in Method]: { id: number; method: M; params: Params<M> };
}[Method];
export type WorkerResponse =
  | { id: number | null; ok: true; value: unknown }
  | { id: number | null; ok: false; error: { code: string; message: string } };
export type WorkerCall = <M extends Method>(
  method: M,
  params: Params<M>,
  signal?: AbortSignal,
) => Promise<Result<M>>;
