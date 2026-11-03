import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createEmbedder } from '../dist/embedding/client.js';
import { chunkText } from '../dist/core/chunking.js';
import { errorCode } from '../dist/shared/model.js';

const mode = process.argv[2] ?? 'inventory';
const root = resolve(process.argv[3] ?? '.benchmark/qwen-vllm');
const sources = ['captions_coco10k.txt', 'mixkit_prompts_vid.txt'];
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
await mkdir(root, { recursive: true, mode: 0o700 });
async function save(name: string, value: unknown): Promise<void> {
  await writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function inventory() {
  const reports = [];
  for (const name of sources) {
    const path = resolve('test/test-chunks', name);
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const nonempty = lines.filter((line) => line.trim().length > 0);
    const lengths = nonempty.map((line) => Array.from(line).length).sort((a, b) => a - b);
    let chunks = 0,
      chunkChars = 0,
      maxChunk = 0;
    for (const line of nonempty)
      for (const chunk of chunkText(line)) {
        chunks++;
        chunkChars += chunk.text.length;
        maxChunk = Math.max(maxChunk, Array.from(chunk.text).length);
      }
    reports.push({
      name,
      sha256: hash(bytes),
      bytes: (await stat(path)).size,
      lines: lines.length,
      nonempty: nonempty.length,
      uniqueExactTexts: new Set(nonempty).size,
      lengthCodepoints: {
        min: lengths[0],
        p50: lengths[Math.floor(lengths.length * 0.5)],
        p95: lengths[Math.floor(lengths.length * 0.95)],
        max: lengths.at(-1),
      },
      productionChunks: chunks,
      chunkUtf16Units: chunkChars,
      maxChunkCodepoints: maxChunk,
    });
  }
  const report = {
    at: new Date().toISOString(),
    sources: reports,
    totals: {
      lines: reports.reduce((n, r) => n + r.nonempty, 0),
      vectors: reports.reduce((n, r) => n + r.productionChunks, 0),
    },
    limits: [
      'One source line is one source block; production paragraph-v1 splits long lines.',
      'Duplicate lines keep distinct source provenance.',
      'Text-only evaluation; no image or video bytes are sent.',
    ],
  };
  await save('inventory.json', report);
  console.log(JSON.stringify(report, null, 2));
}
async function probe() {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_EMBEDDING_MODEL;
  if (!baseURL || !apiKey || !model)
    throw new Error('Missing embedding configuration; no request sent.');
  const endpointIdentity = hash(new URL(baseURL).origin + new URL(baseURL).pathname);
  const samples = [
    'A cyclist rides a bicycle along a quiet road.',
    '一个人正沿着安静的道路骑自行车。',
    'A database stores an exact copy of the original conversation.',
  ];
  const requests: {
    count: number;
    ms: number;
    status?: number;
    usage?: unknown;
    error?: string;
  }[] = [];
  const embedder = createEmbedder(
    {
      baseURL,
      apiKey,
      model,
      batchSize: 8,
      ...(process.env.OPENAI_EMBEDDING_DIMENSIONS
        ? { dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) }
        : {}),
    },
    {
      fetchImpl: async (url, init) => {
        const start = performance.now();
        const count = (JSON.parse(init.body) as { input: string[] }).input.length;
        try {
          const response = await fetch(url, init);
          const entry = {
            count,
            ms: performance.now() - start,
            status: response.status,
          } as (typeof requests)[number];
          requests.push(entry);
          return {
            ok: response.ok,
            async json() {
              const payload = (await response.json()) as { usage?: unknown };
              entry.usage = payload.usage;
              entry.ms = performance.now() - start;
              return payload;
            },
          };
        } catch (error) {
          requests.push({
            count,
            ms: performance.now() - start,
            error: errorCode(error, 'NETWORK_ERROR'),
          });
          throw error;
        }
      },
    },
  );
  let output: unknown;
  try {
    const vectors = await embedder.embed(samples);
    const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    const cosine = (a: number[], b: number[]) =>
      a.reduce((sum, x, i) => sum + x * b[i], 0) / (norm(a) * norm(b));
    output = {
      ok: true,
      at: new Date().toISOString(),
      model,
      endpointIdentity,
      spaceId: embedder.spaceId,
      dimensions: vectors[0].length,
      norms: vectors.map(norm),
      englishChineseCosine: cosine(vectors[0], vectors[1]),
      unrelatedCosine: cosine(vectors[0], vectors[2]),
      requests,
    };
  } catch (error) {
    output = {
      ok: false,
      at: new Date().toISOString(),
      model,
      endpointIdentity,
      error: errorCode(error, 'PROBE_FAILED'),
      requests,
    };
    process.exitCode = 1;
  }
  await save('probe.json', output);
  console.log(JSON.stringify(output, null, 2));
}
if (mode === 'inventory') await inventory();
else if (mode === 'probe') await probe();
else throw new Error('Expected inventory or probe.');
