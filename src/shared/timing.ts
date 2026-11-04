import { AsyncLocalStorage } from 'node:async_hooks';

/** Diagnostic-only durations: never query text, paths, IDs, URLs or credentials. */
export const TIMING_NAMES = [
  'host.initialize',
  'host.scope',
  'host.synchronize',
  'host.embedding-catchup',
  'host.search',
  'host.read',
  'host.source-verify',
  'bridge.wait-ready',
  'bridge.roundtrip',
  'bridge.residual',
  'worker.queue',
  'worker.total',
  'embedding.http',
  'embedding.validate',
  'store.scope',
  'store.query-embedding',
  'store.vector-index',
  'store.vector-fetch',
  'store.rerank',
  'store.source-lookup',
  'store.pending',
  'store.snapshot',
  'store.progress-index',
] as const;
export type TimingName = (typeof TIMING_NAMES)[number];
export interface TimingSpan {
  name: TimingName;
  ms: number;
  count: number;
}
export interface TimingReport {
  totalMs: number;
  spans: TimingSpan[];
}
const context = new AsyncLocalStorage<Map<TimingName, TimingSpan>>();
const names = new Set<string>(TIMING_NAMES);
export function timingEnabled(): boolean {
  return context.getStore() !== undefined;
}
export function recordTiming(name: TimingName, ms: number, count = 1): void {
  const spans = context.getStore();
  if (!spans) return;
  if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(count) || count < 1) return;
  const prior = spans.get(name);
  if (prior) {
    prior.ms += ms;
    prior.count += count;
  } else spans.set(name, { name, ms, count });
}
export function startTiming(name: TimingName): () => void {
  if (!timingEnabled()) return () => {};
  const start = performance.now();
  return () => recordTiming(name, performance.now() - start);
}
export async function timed<T>(name: TimingName, operation: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    recordTiming(name, performance.now() - start);
  }
}
export function timedSync<T>(name: TimingName, operation: () => T): T {
  if (!timingEnabled()) return operation();
  const start = performance.now();
  try {
    return operation();
  } finally {
    recordTiming(name, performance.now() - start);
  }
}
export async function captureTiming<T>(
  operation: () => Promise<T>,
  onReport?: (report: TimingReport) => void,
): Promise<{ value: T; timing: TimingReport }> {
  const spans = new Map<TimingName, TimingSpan>();
  const start = performance.now();
  let timing: TimingReport;
  try {
    const value = await context.run(spans, operation);
    timing = { totalMs: performance.now() - start, spans: [...spans.values()] };
    return { value, timing };
  } finally {
    timing ??= { totalMs: performance.now() - start, spans: [...spans.values()] };
    if (onReport) {
      try {
        onReport(timing);
      } catch {
        /* Diagnostics never change operation outcomes. */
      }
    }
  }
}
/** Validate the optional JSONL diagnostic envelope without copying extra fields. */
export function parseTiming(value: unknown): TimingReport | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.totalMs !== 'number' ||
    !Number.isFinite(row.totalMs) ||
    row.totalMs < 0 ||
    !Array.isArray(row.spans) ||
    row.spans.length > TIMING_NAMES.length
  )
    return undefined;
  const seen = new Set<string>();
  const spans: TimingSpan[] = [];
  for (const entry of row.spans as unknown[]) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.name !== 'string' ||
      !names.has(item.name) ||
      seen.has(item.name) ||
      typeof item.ms !== 'number' ||
      !Number.isFinite(item.ms) ||
      item.ms < 0 ||
      typeof item.count !== 'number' ||
      !Number.isSafeInteger(item.count) ||
      item.count < 1
    )
      return undefined;
    seen.add(item.name);
    spans.push({ name: item.name as TimingName, ms: item.ms, count: item.count });
  }
  return { totalMs: row.totalMs, spans };
}
export function mergeTiming(report: TimingReport): void {
  for (const span of report.spans) recordTiming(span.name, span.ms, span.count);
}
