import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openStore } from '../dist/storage/store.js';
import { createEmbedder } from '../dist/embedding/client.js';

const root = resolve(process.argv[2] ?? '.benchmark/qwen-vllm');
const sourceNames = ['captions_coco10k.txt', 'mixkit_prompts_vid.txt'];
const sessions = sourceNames.map((_name, index) => `evaluation-source-${index}`);
interface Query {
  id: string;
  source: string | null;
  line: number | null;
  kind: string;
  language: string;
  query: string;
  targetHash?: string;
}
const queries = (
  JSON.parse(await readFile('evaluation/queries.json', 'utf8')) as { queries: Query[] }
).queries.filter((q) => q.kind === 'positive' && q.language === 'en');
const lines = await Promise.all(
  sourceNames.map(async (name) =>
    (await readFile(resolve('test/test-chunks', name), 'utf8')).split(/\r?\n/),
  ),
);
const apiKey = process.env.OPENAI_API_KEY,
  baseURL = process.env.OPENAI_BASE_URL,
  model = process.env.OPENAI_EMBEDDING_MODEL;
if (!apiKey || !baseURL || !model) throw new Error('Missing configured space identity.');
const client = createEmbedder({
  apiKey,
  baseURL,
  model,
  ...(process.env.OPENAI_EMBEDDING_DIMENSIONS
    ? { dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) }
    : {}),
});
let attemptedRequests = 0;
const storeOptions = {
  root: join(root, 'index'),
  embedder: {
    spaceId: client.spaceId,
    async embed() {
      attemptedRequests++;
      throw new Error('This verification must not request any embeddings.');
    },
  },
};
let store = await openStore(storeOptions);
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
try {
  const before = await store.status();
  const start = performance.now();
  const reused = await store.embed({ sessionIds: sessions });
  const reuseMs = performance.now() - start;
  if (
    reused.new !== 0 ||
    reused.reused !== 18186 ||
    reused.remaining !== 0 ||
    attemptedRequests !== 0
  )
    throw new Error('Persistence reuse failed.');
  const results = [];
  const stopwords = new Set([
    'video',
    'showcases',
    'throughout',
    'scene',
    'initially',
    'continues',
    'remains',
    'consistent',
    'background',
    'setting',
    'there',
    'their',
    'while',
    'which',
    'with',
    'this',
    'that',
    'from',
    'into',
    'where',
    'these',
    'those',
  ]);
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const q = queries[queryIndex];
    // Production snapshots intentionally cap live searches at64. Rotate the
    // test process-store every16 cases (48 searches), not the production limit.
    if (queryIndex > 0 && queryIndex % 16 === 0) {
      await store.close();
      store = await openStore(storeOptions);
    }
    const index = sourceNames.indexOf(q.source!);
    const line = lines[index][q.line! - 1];
    if (createHash('sha256').update(line).digest('hex') !== q.targetHash)
      throw new Error('Frozen source line changed.');
    const literal = line.slice(0, 100);
    const beforeExact = performance.now();
    const exact = await store.search({
      query: literal,
      mode: 'exact',
      sessionIds: sessions,
      limit: 20,
      binding: 'lexical-evaluation',
    });
    const exactMs = performance.now() - beforeExact;
    const exactTargetRank =
      exact.hits.findIndex(
        (hit) => hit.sessionId === sessions[index] && hit.eventSeq === q.line! - 1,
      ) + 1 || null;
    const words = [...new Set(line.match(/[A-Za-z]{5,}/g) ?? [])]
      .filter((word) => !stopwords.has(word.toLowerCase()))
      .slice(0, 4);
    const fuzzyQuery = words.join(' '),
      beforeFuzzy = performance.now();
    const fuzzy = await store.search({
      query: fuzzyQuery,
      mode: 'fuzzy',
      sessionIds: sessions,
      limit: 20,
      binding: 'lexical-evaluation',
    });
    const fuzzyMs = performance.now() - beforeFuzzy;
    const reversed = await store.search({
      query: [...words].reverse().join(' '),
      mode: 'fuzzy',
      sessionIds: sessions,
      limit: 20,
      binding: 'lexical-evaluation',
    });
    const fuzzyTargetRank =
      fuzzy.hits.findIndex(
        (hit) => hit.sessionId === sessions[index] && hit.eventSeq === q.line! - 1,
      ) + 1 || null;
    const identity = (hits: typeof fuzzy.hits) => hits.map((hit) => hit.ref).join('\n');
    results.push({
      id: q.id,
      source: q.source,
      line: q.line,
      exactMs,
      exactTargetRank,
      exactHits: exact.totalCandidates,
      exactVerified: exact.hits.every((hit) =>
        lines[sessions.indexOf(hit.sessionId)][hit.eventSeq].includes(literal),
      ),
      fuzzyMs,
      fuzzyQuery,
      fuzzyTargetRank,
      fuzzyTopCoverage: fuzzy.hits[0]?.coverage,
      orderInsensitive: identity(fuzzy.hits) === identity(reversed.hits),
      candidateTruncated: fuzzy.candidateTruncated,
    });
  }
  const report = {
    at: new Date().toISOString(),
    blocks: before.counts.blocks,
    vectors: before.counts.vectors,
    reuse: { ...reused, ms: reuseMs, embeddingRequests: attemptedRequests },
    cases: results.length,
    exact: {
      targetInTop20: results.filter((r) => r.exactTargetRank !== null).length,
      allReturnedLiteralMatches: results.every((r) => r.exactVerified),
      p50Ms: percentile(
        results.map((r) => r.exactMs),
        0.5,
      ),
      p95Ms: percentile(
        results.map((r) => r.exactMs),
        0.95,
      ),
    },
    fuzzy: {
      targetInTop20: results.filter((r) => r.fuzzyTargetRank !== null).length,
      identicalOrderAfterReversingWords: results.filter((r) => r.orderInsensitive).length,
      p50Ms: percentile(
        results.map((r) => r.fuzzyMs),
        0.5,
      ),
      p95Ms: percentile(
        results.map((r) => r.fuzzyMs),
        0.95,
      ),
    },
    results,
    limitations: [
      'Exact queries are deterministic source prefixes, not natural-language semantic queries.',
      'Fuzzy queries use four source words; this checks literal keyword handling, not semantic quality.',
      'One run with warmed filesystem cache; no general performance guarantee.',
    ],
  };
  await writeFile(join(root, 'lexical-reuse.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
} finally {
  await store.close();
}
