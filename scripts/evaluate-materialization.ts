import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEmbedder } from '../dist/embedding/client.js';
import { openStore as optimizedStore } from '../dist/storage/store.js';
import type { RecallStore, OpenStoreOptions } from '../dist/storage/store.js';

const root = resolve(process.argv[2] ?? '.benchmark/qwen-vllm');
const installed = process.argv[3];
if (!installed) throw new Error('Pass the installed baseline store entry path explicitly.');
const { openStore: baselineStore } = (await import(pathToFileURL(resolve(installed)).href)) as {
  openStore: (options: OpenStoreOptions) => Promise<RecallStore>;
};
const manifest = JSON.parse(await readFile('evaluation/queries.json', 'utf8')) as {
  queries: { id: string; query: string }[];
};
// Eight fixed positions, selected without looking at the before/after ranking changes.
const selected = [0, 7, 14, 21, 28, 35, 42, 49].map((index) => manifest.queries[index]);
const baseURL = process.env.OPENAI_BASE_URL,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_EMBEDDING_MODEL;
if (!baseURL || !apiKey || !model) throw new Error('Missing authorized model settings.');
const client = createEmbedder({
  baseURL,
  apiKey,
  model,
  batchSize: 8,
  ...(process.env.OPENAI_EMBEDDING_DIMENSIONS
    ? { dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) }
    : {}),
});
const values = await client.embed(selected.map((row) => row.query));
await writeFile(
  join(root, 'materialization-query-vectors.json'),
  JSON.stringify({
    spaceId: client.spaceId,
    queries: selected.map((row, i) => ({ ...row, vector: values[i] })),
  }),
  { mode: 0o600 },
);
const cache = new Map(selected.map((row, i) => [row.query, values[i]]));
const embedder = {
  spaceId: client.spaceId,
  async embed(texts: string[]) {
    return texts.map((text) => {
      const vector = cache.get(text);
      if (!vector) throw new Error('Unexpected text in fixed-query ablation.');
      return vector;
    });
  },
};
const results: {
  variant: 'baseline' | 'batched';
  id: string;
  totalMs: number;
  candidates: number;
  rankHash: string;
  top10: { ref: string; similarity: number | undefined }[];
}[] = [];
for (const [variant, openStore] of [
  ['baseline', baselineStore],
  ['batched', optimizedStore],
] as const) {
  const store = await openStore({ root: join(root, 'index'), embedder });
  try {
    for (const row of selected) {
      const start = performance.now();
      const result = await store.search({
        mode: 'semantic',
        query: row.query,
        sessionIds: ['evaluation-source-0', 'evaluation-source-1'],
        limit: 20,
        binding: 'same-vector-ablation',
      });
      const hits = [...result.hits];
      let cursor = result.nextCursor;
      while (cursor) {
        const next = await store.search({
          mode: 'semantic',
          query: row.query,
          sessionIds: ['evaluation-source-0', 'evaluation-source-1'],
          limit: 20,
          binding: 'same-vector-ablation',
          cursor,
        });
        hits.push(...next.hits);
        cursor = next.nextCursor;
      }
      results.push({
        variant,
        id: row.id,
        totalMs: performance.now() - start,
        candidates: hits.length,
        rankHash: createHash('sha256').update(JSON.stringify(hits)).digest('hex'),
        top10: hits.slice(0, 10).map((hit) => ({ ref: hit.ref, similarity: hit.similarity })),
      });
    }
  } finally {
    await store.close();
  }
}
const pairs = selected.map((row) => {
  const before = results.find((item) => item.variant === 'baseline' && item.id === row.id)!,
    after = results.find((item) => item.variant === 'batched' && item.id === row.id)!;
  return {
    id: row.id,
    baselineMs: before.totalMs,
    batchedMs: after.totalMs,
    candidates: after.candidates,
    allCandidateBodiesAndRankingIdentical: before.rankHash === after.rankHash,
  };
});
const report = {
  at: new Date().toISOString(),
  model,
  queries: selected.length,
  sameVectors: true,
  identical: pairs.filter((row) => row.allCandidateBodiesAndRankingIdentical).length,
  pairs,
  notes: [
    'Same cached vectors for both implementations; one batch of eight query embeddings.',
    'Timing includes consuming the entire immutable snapshot in both variants.',
    'Baseline installed store0.3.1 vs working-tree batched candidate hydration.',
  ],
};
await writeFile(
  join(root, 'materialization-ablation.json'),
  JSON.stringify(report, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
