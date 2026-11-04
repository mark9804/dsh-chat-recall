import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openStore } from '../dist/storage/store.js';
import { captureTiming } from '../dist/shared/timing.js';
import lance from '../dist/storage/lance.js';

const root = resolve('.benchmark/qwen-vllm');
const output = resolve('.benchmark/progress-fix-results');
await mkdir(output, { recursive: true, mode: 0o700 });
const cache = JSON.parse(
  await readFile(join(root, 'materialization-query-vectors.json'), 'utf8'),
) as { spaceId: string; queries: { id: string; query: string; vector: number[] }[] };
const baseline = JSON.parse(
  await readFile('.benchmark/latency-2026-11-03T05-39-01-994Z/results.json', 'utf8'),
) as {
  results: {
    id: string;
    repetition: number;
    totalCandidates: number;
    top20: { ref: string; score: number }[];
  }[];
};
const vectors = new Map(cache.queries.map((q) => [q.query, q.vector]));
let calls = 0;
const embedder = {
  spaceId: cache.spaceId,
  async embed(texts: string[]) {
    calls++;
    return texts.map((text) => {
      const vector = vectors.get(text);
      if (!vector) throw Error('No new embeddings allowed in offline validation.');
      return vector;
    });
  },
};
const store = await openStore({ root: join(root, 'index'), embedder });
const results = [];
try {
  for (let repetition = 0; repetition < 3; repetition++)
    for (const q of cache.queries) {
      const measured = await captureTiming(() =>
        store.search({
          query: q.query,
          mode: 'semantic',
          sessionIds: ['evaluation-source-0', 'evaluation-source-1'],
          binding: 'progress-fix-validation',
          limit: 20,
        }),
      );
      const old = baseline.results.find((row) => row.id === q.id && row.repetition === repetition)!;
      const top20 = measured.value.hits.map((hit) => ({ ref: hit.ref, score: hit.similarity }));
      results.push({
        id: q.id,
        repetition,
        timing: measured.timing,
        pending: measured.value.coverage.pendingBlocks,
        top20AndCountsUnchanged:
          JSON.stringify(old.top20) === JSON.stringify(top20) &&
          old.totalCandidates === measured.value.totalCandidates,
      });
    }
  const before = calls;
  const reuse = await captureTiming(() =>
    store.embed({ sessionIds: ['evaluation-source-0', 'evaluation-source-1'] }),
  );
  if (calls !== before) throw Error('Unexpected document embedding call.');
  await writeFile(join(output, 'reuse.json'), JSON.stringify(reuse, null, 2) + '\n', {
    mode: 0o600,
  });
} finally {
  await store.close();
}
const db = await lance.connect(join(root, 'index/db'));
const table = await db.openTable('embedding_progress');
let indices;
try {
  indices = await table.listIndices();
} finally {
  table.close();
  db.close();
}
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)];
const warm = results.slice(1);
const report = {
  at: new Date().toISOString(),
  networkRequests: 0,
  searches: results.length,
  unchanged: results.filter((row) => row.top20AndCountsUnchanged).length,
  pendingValues: [...new Set(results.map((row) => row.pending))],
  firstMs: results[0].timing.totalMs,
  warmMs: {
    p50: pct(
      warm.map((row) => row.timing.totalMs),
      0.5,
    ),
    p95: pct(
      warm.map((row) => row.timing.totalMs),
      0.95,
    ),
  },
  warmPendingMs: pct(
    warm.map((row) => row.timing.spans.find((s) => s.name === 'store.pending')!.ms),
    0.5,
  ),
  indices,
  results,
};
await writeFile(join(output, 'search.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
