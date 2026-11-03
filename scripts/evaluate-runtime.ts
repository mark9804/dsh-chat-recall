import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createEmbedder } from '../dist/embedding/client.js';
import { openStore } from '../dist/storage/store.js';
import type { RecallStore } from '../dist/storage/store.js';
import type { MessageRow, BlockRow, Embedder, SearchHit } from '../dist/shared/model.js';
import { errorCode } from '../dist/shared/model.js';
import lance from '../dist/storage/lance.js';

const stage = process.argv[2] ?? 'embed';
const root = resolve(process.argv[3] ?? '.benchmark/qwen-vllm');
const database = join(root, 'index');
const files = ['captions_coco10k.txt', 'mixkit_prompts_vid.txt'];
const sessionIds = files.map((_name, index) => `evaluation-source-${index}`);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const baseURL = process.env.OPENAI_BASE_URL,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_EMBEDDING_MODEL;
if (!baseURL || !apiKey || !model) throw new Error('Missing authorized embedding configuration.');
await mkdir(root, { recursive: true, mode: 0o700 });
const stop = new AbortController();
const stopWork = () => stop.abort();
process.once('SIGINT', stopWork);
process.once('SIGTERM', stopWork);
let peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 500);
memoryTimer.unref();
let phase = stage;
const requests: {
  phase: string;
  count: number;
  ms: number;
  status?: number;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: string;
}[] = [];
const queryVectors = new Map<string, number[]>();
const raw = createEmbedder(
  {
    baseURL,
    apiKey,
    model,
    batchSize: 64,
    ...(process.env.OPENAI_EMBEDDING_DIMENSIONS
      ? { dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) }
      : {}),
  },
  {
    fetchImpl: async (url, init) => {
      const input = (JSON.parse(init.body) as { input: string[] }).input;
      const start = performance.now();
      const entry: (typeof requests)[number] = { phase, count: input.length, ms: 0 };
      try {
        const response = await fetch(url, init);
        entry.status = response.status;
        return {
          ok: response.ok,
          async json() {
            const result = (await response.json()) as {
              usage?: { prompt_tokens?: number; total_tokens?: number };
            };
            entry.usage = result.usage;
            entry.ms = performance.now() - start;
            requests.push(entry);
            await appendFile(
              join(root, 'http-audit.jsonl'),
              JSON.stringify({
                ...entry,
                at: new Date().toISOString(),
                inputHashes: input.map(hash),
              }) + '\n',
              { mode: 0o600 },
            );
            if (requests.length % 10 === 0)
              console.log(
                JSON.stringify({
                  phase,
                  requests: requests.length,
                  texts: requests.reduce((n, r) => n + r.count, 0),
                  lastMs: Math.round(entry.ms),
                  rssMiB: Math.round(process.memoryUsage().rss / 1048576),
                }),
              );
            return result;
          },
        };
      } catch (error) {
        entry.ms = performance.now() - start;
        entry.error = errorCode(error, 'NETWORK_ERROR');
        requests.push(entry);
        await appendFile(
          join(root, 'http-audit.jsonl'),
          JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n',
          { mode: 0o600 },
        );
        throw error;
      }
    },
  },
);
const embedder: Embedder = {
  spaceId: raw.spaceId,
  async embed(texts, signal) {
    const result = await raw.embed(
      texts,
      signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
    );
    if (phase === 'queries') texts.forEach((text, index) => queryVectors.set(text, result[index]));
    return result;
  },
};
async function save(name: string, data: unknown): Promise<void> {
  await writeFile(join(root, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
const sources = await Promise.all(
  files.map(async (name, index) => {
    const bytes = await readFile(resolve('test/test-chunks', name));
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (lines.some((line) => !line.trim()))
      throw new Error('Review empty source lines before assigning provenance.');
    return { name, sessionId: sessionIds[index], sha256: hash(bytes), lines };
  }),
);
const identity = {
  spaceId: embedder.spaceId,
  model,
  sources: sources.map(({ name, sessionId, sha256, lines }) => ({
    name,
    sessionId,
    sha256,
    lines: lines.length,
  })),
  protocol:
    'OpenAI-compatible /embeddings, plain text as current production; no custom query instruction',
};
try {
  const existing = JSON.parse(await readFile(join(root, 'run-identity.json'), 'utf8')) as unknown;
  if (JSON.stringify(existing) !== JSON.stringify(identity))
    throw new Error('Benchmark identity changed; use another output directory.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await save('run-identity.json', identity);
}
let store: RecallStore | undefined;
const started = performance.now();
async function indexSources(): Promise<number> {
  const start = performance.now();
  const checkpoints = (await store!.checkpoints()).sessions;
  for (const source of sources) {
    const cursor = checkpoints.find((row) => row.sessionId === source.sessionId)?.cursor ?? -1;
    for (let offset = cursor + 1; offset < source.lines.length; offset += 256) {
      stop.signal.throwIfAborted();
      const texts = source.lines.slice(offset, offset + 256);
      const messages: MessageRow[] = [],
        blocks: BlockRow[] = [];
      texts.forEach((text, index) => {
        const seq = offset + index,
          id = `${source.sessionId}:${seq}`;
        messages.push({
          id,
          sessionId: source.sessionId,
          title: source.name,
          cwd: '/authorized-evaluation',
          origin: 'main',
          archived: false,
          eventSeq: seq,
          time: seq + 1,
          role: 'user',
          contentJson: JSON.stringify([{ type: 'text', text, blockIndex: 0 }]),
        });
        blocks.push({
          id: `${id}:0`,
          messageId: id,
          sessionId: source.sessionId,
          origin: 'main',
          role: 'user',
          time: seq + 1,
          eventSeq: seq,
          blockIndex: 0,
          text,
        });
      });
      const last = offset + texts.length - 1;
      await store!.sync({
        session: {
          sessionId: source.sessionId,
          title: source.name,
          cwd: '/authorized-evaluation',
          origin: 'main',
          createdAt: 1,
          inheritedEventCount: 0,
          cursor: last,
          anchorHash: hash(source.lines[last]),
          updatedAt: last + 1,
        },
        messages,
        blocks,
      });
    }
  }
  return performance.now() - start;
}
async function diskBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    if (item.isDirectory()) bytes += await diskBytes(child);
    else if (item.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}
const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
interface Query {
  id: string;
  source: string | null;
  line: number | null;
  language: string;
  kind: string;
  query: string;
}
async function evaluate(): Promise<void> {
  const frozen = JSON.parse(await readFile(join(root, 'query-freeze.json'), 'utf8')) as {
    querySetSha256: string;
  };
  if (hash(await readFile(resolve('evaluation/queries.json'))) !== frozen.querySetSha256)
    throw new Error('Frozen queries changed.');
  const queryFile = await readFile(resolve('evaluation/queries.json'), 'utf8');
  const queries = (JSON.parse(queryFile) as { queries: Query[] }).queries;
  phase = 'queries';
  const results = [];
  for (const q of queries) {
    const before = requests.length,
      start = performance.now();
    const result = await store!.search({
      mode: 'semantic',
      query: q.query,
      sessionIds,
      limit: 10,
      binding: 'authorized-evaluation',
    });
    const elapsedMs = performance.now() - start;
    const pageStart = performance.now();
    const after = requests.length;
    const next = result.nextCursor
      ? await store!.search({
          mode: 'semantic',
          query: q.query,
          sessionIds,
          limit: 10,
          binding: 'authorized-evaluation',
          cursor: result.nextCursor,
        })
      : null;
    if (requests.length !== after)
      throw new Error('Cursor continuation unexpectedly embedded again.');
    const session = q.source ? sessionIds[files.indexOf(q.source)] : undefined;
    const rank =
      q.line == null
        ? null
        : result.hits.findIndex(
            (hit) => hit.sessionId === session && hit.eventSeq === q.line! - 1,
          ) + 1 || null;
    results.push({
      ...q,
      elapsedMs,
      continuationMs: performance.now() - pageStart,
      queryRequests: after - before,
      targetRankTop10: rank,
      coverage: result.coverage,
      top10: result.hits.map((hit) => ({
        ref: hit.ref,
        score: hit.similarity,
        source: files[sessionIds.indexOf(hit.sessionId)],
        line: hit.eventSeq + 1,
      })),
      continuationHits: next?.hits.length ?? 0,
    });
  }
  await save('semantic-queries.json', { querySetSha256: hash(queryFile), results });
  // Independent exact cosine ground truth, using the same query vectors but no embedding requests.
  await store!.close();
  store = undefined;
  const db = await lance.connect(join(database, 'db'));
  const table = await db.openTable('vectors');
  try {
    const all = await table
      .query()
      .select(['chunkId', 'sessionId', 'eventSeq', 'vector'])
      .toArray();
    const dims = Array.from((all[0] as unknown as { vector: Iterable<number> }).vector).length;
    const matrix = new Float32Array(all.length * dims),
      norms = new Float64Array(all.length);
    const metadata: { chunkId: string; ref: string }[] = [];
    for (let i = 0; i < all.length; i++) {
      const row = all[i] as unknown as {
        chunkId: string;
        sessionId: string;
        eventSeq: number;
        vector: Iterable<number>;
      };
      const values = Array.from(row.vector);
      let norm = 0;
      for (let j = 0; j < dims; j++) {
        const value = values[j];
        matrix[i * dims + j] = value;
        norm += value * value;
      }
      norms[i] = Math.sqrt(norm);
      metadata.push({ chunkId: row.chunkId, ref: `${row.sessionId}:${row.eventSeq}` });
    }
    const details = [];
    for (const q of queries) {
      const vector = queryVectors.get(q.query)!;
      const qnorm = Math.sqrt(vector.reduce((n, x) => n + x * x, 0));
      const start = performance.now();
      const scores: { index: number; score: number }[] = [];
      for (let i = 0; i < metadata.length; i++) {
        let dot = 0;
        for (let j = 0; j < dims; j++) dot += matrix[i * dims + j] * vector[j];
        scores.push({ index: i, score: dot / (norms[i] * qnorm) });
      }
      scores.sort(
        (a, b) =>
          b.score - a.score || metadata[a.index].chunkId.localeCompare(metadata[b.index].chunkId),
      );
      const flatMs = performance.now() - start;
      const flatChunks = scores.slice(0, 10).map((r) => metadata[r.index].chunkId);
      const bestRows: { ref: string; score: number }[] = [];
      const seen = new Set<string>();
      for (const row of scores) {
        const ref = metadata[row.index].ref;
        if (!seen.has(ref)) {
          seen.add(ref);
          bestRows.push({ ref, score: row.score });
        }
      }
      const scope = q.source ? sessionIds[files.indexOf(q.source)] : null;
      const target = q.line == null ? null : `${scope}:${q.line - 1}`;
      const flatTargetRank = target
        ? bestRows.findIndex((row) => row.ref === target) + 1 || null
        : null;
      const startAnn = performance.now();
      const ann = await table
        .vectorSearch(vector)
        .distanceType('cosine')
        .nprobes(32)
        .limit(1000)
        .select(['chunkId', 'vector'])
        .toArray();
      const scoredAnn = ann
        .map((item) => {
          const row = item as unknown as { chunkId: string; vector: Iterable<number> };
          const values = Array.from(row.vector);
          let dot = 0,
            norm = 0;
          for (let j = 0; j < dims; j++) {
            dot += values[j] * vector[j];
            norm += values[j] * values[j];
          }
          return { chunkId: row.chunkId, score: dot / (Math.sqrt(norm) * qnorm) };
        })
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
      const top = new Set(scoredAnn.slice(0, 10).map((row) => row.chunkId));
      const candidate = new Set(scoredAnn.map((row) => row.chunkId));
      const prod = new Set(results.find((row) => row.id === q.id)!.top10.map((row) => row.ref));
      details.push({
        id: q.id,
        language: q.language,
        kind: q.kind,
        flatMs,
        annMs: performance.now() - startAnn,
        flatTargetRank,
        annChunkRecallAt10: flatChunks.filter((id) => top.has(id)).length / flatChunks.length,
        annCandidateRecallOfFlatTop10:
          flatChunks.filter((id) => candidate.has(id)).length / flatChunks.length,
        productionSourceOverlapAt10:
          bestRows.slice(0, 10).filter((row) => prod.has(row.ref)).length /
          Math.min(10, bestRows.length),
        flatTop10: bestRows.slice(0, 10),
      });
    }
    const positives = results.filter((row) => row.kind === 'positive');
    const hitAt = (rows: typeof positives, k: number) =>
      rows.filter((row) => row.targetRankTop10 !== null && row.targetRankTop10 <= k).length /
      rows.length;
    const groups = Object.fromEntries(
      ['all', 'en', 'zh'].map((lang) => {
        const rows = positives.filter((q) => lang === 'all' || q.language === lang);
        return [
          lang,
          {
            queries: rows.length,
            hitAt1: hitAt(rows, 1),
            hitAt3: hitAt(rows, 3),
            hitAt5: hitAt(rows, 5),
            hitAt10: hitAt(rows, 10),
          },
        ];
      }),
    );
    await save('ann-vs-flat.json', { dimensions: dims, vectors: all.length, details });
    await save('evaluation-summary.json', {
      at: new Date().toISOString(),
      model,
      querySetSha256: hash(queryFile),
      groups,
      meanAnnChunkRecallAt10:
        details.reduce((n, r) => n + r.annChunkRecallAt10, 0) / details.length,
      meanAnnCandidateRecallOfFlatTop10:
        details.reduce((n, r) => n + r.annCandidateRecallOfFlatTop10, 0) / details.length,
      productionMs: {
        p50: percentile(
          results.map((row) => row.elapsedMs),
          0.5,
        ),
        p95: percentile(
          results.map((row) => row.elapsedMs),
          0.95,
        ),
        first: results[0]?.elapsedMs,
      },
      queryRequests: requests.length,
      totalMs: performance.now() - started,
      peakRssMiB: peakRss / 1048576,
      notes: [
        'Known-source target Hit, not fully adjudicated relevance.',
        'Negative queries inspected separately; no automatic abstention claim.',
        'The first query creates a vector index only if none exists; reruns reuse it. Report these separately.',
        'Client only RSS; vLLM GPU memory/throughput not measured.',
      ],
    });
  } finally {
    table.close();
    db.close();
  }
  console.log(await readFile(join(root, 'evaluation-summary.json'), 'utf8'));
}
try {
  store = await openStore({ root: database, embedder });
  if (stage === 'embed') {
    phase = 'index';
    const syncMs = await indexSources();
    const before = await store.status();
    console.log(JSON.stringify({ indexed: true, syncMs, before }));
    phase = 'documents';
    const start = performance.now();
    const embedded = await store.embed({ sessionIds });
    const embedMs = performance.now() - start;
    const status = await store.status();
    const report = {
      at: new Date().toISOString(),
      identity,
      syncMs,
      embedMs,
      totalMs: performance.now() - started,
      embedded,
      status,
      http: {
        requests: requests.length,
        texts: requests.reduce((n, r) => n + r.count, 0),
        promptTokens: requests.reduce((n, r) => n + (r.usage?.prompt_tokens ?? 0), 0),
        latencyMs: {
          p50: percentile(
            requests.map((r) => r.ms),
            0.5,
          ),
          p95: percentile(
            requests.map((r) => r.ms),
            0.95,
          ),
        },
      },
      peakRssMiB: peakRss / 1048576,
      diskBytes: await diskBytes(database),
    };
    await save('embedding-summary.json', report);
    console.log(JSON.stringify(report, null, 2));
  } else if (stage === 'evaluate') await evaluate();
  else throw new Error('Expected embed or evaluate.');
} catch (error) {
  await save(`failure-${stage}.json`, {
    at: new Date().toISOString(),
    stage,
    code: errorCode(error, 'EVALUATION_FAILED'),
    requests: requests.length,
    totalMs: performance.now() - started,
  });
  console.error(JSON.stringify({ stage, code: errorCode(error, 'EVALUATION_FAILED') }));
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  process.removeListener('SIGINT', stopWork);
  process.removeListener('SIGTERM', stopWork);
  await store?.close();
}
